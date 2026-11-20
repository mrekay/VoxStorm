/* Dock: the left and right side panels of AI mode, built like Visual Studio / VS Code.

   Views: projects, decisions, agents, usage and plugin side sections ("plug:<plugin>:<panel>").
   Each side has an activity bar (icon strip at the window edge) and a panel area made of
   columns; a column holds groups stacked top to bottom; a group shows one view at a time
   with tabs when it holds more than one.

   - Activity bar: click an icon to show that view; clicking the view that is already showing
     closes the side (like VS Code).
   - Pin (Visual Studio auto-hide), per view: unpinning a view takes it out of its group; it lives
     on the activity bar and slides over the terminal when its icon is clicked; pinning it again
     puts it back where it was.
   - Drag a tab, a group header or an activity icon: over a group a compass offers top / bottom /
     left / right (split) and center (tab); the helper in the middle of the terminal docks it to a
     side as a full-height panel or under the others; dropping on an activity bar adds it to that side.
   - Fold: a group folds to its header line and stays where it is, pinned (click the header or its
     chevron); the other groups of the column take the room.
   - Right-click a tab, a group header or an icon: full height, fold, move, close, pin, reset.

   State: CFG.settings.ui.dock = { left: SIDE, right: SIDE, hidden: [view], auto: [view] }
   SIDE = { open, cols: [{ w, max, groups: [{ views: [view], active, size, folded, fixed }] }] }
   fixed: the user gave a content-sized (fit) group a height of its own with the splitter
   auto: unpinned views (they keep their place in the groups for when they are pinned again)
   cols[0] is the outermost column (next to the window edge). Loaded before app.js; everything
   here runs after app.js has set up ($, CFG, S, setCfg …). */

const DOCK_SIDES = ['left', 'right'];
const DOCK_VIEWS = {
  side: { el: '#sidePanel', name: 'Projeler', icon: 'fa-solid fa-folder-tree', side: 'left', size: 3 },
  // fit: the group is as tall as the view's content by default, and never shorter (it can be made taller)
  usage: { el: '#usage', name: 'Haftalık kullanım', short: 'Kullanım', icon: 'fa-solid fa-chart-column', side: 'left', size: 1.4, fit: true },
  queue: { el: '#queuePanel', name: 'Kararını bekleyenler', short: 'Kararlar', icon: 'fa-solid fa-hand', side: 'right', size: 2 },
  agents: { el: '#agentsPanel', name: "Aktif ajanlar ve workflow'lar", short: 'Ajanlar', icon: 'fa-solid fa-robot', side: 'right', size: 1 },
};
const DOCK_W = { left: 290, right: 310 };
const dockEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dockSideEl = side => document.getElementById(side === 'left' ? 'leftCol' : 'rightCol');
const dockBarEl = side => document.getElementById(side === 'left' ? 'leftRail' : 'rightRail');
let DOCK_PEEK = ''; // the unpinned (auto-hidden) view sliding over the terminal right now
let DOCK_SIG = '';

/* ---------- views ---------- */
function dockPlugSec(k) { return [...document.querySelectorAll('#claudeView .psec[data-maxkey]')].find(x => x.dataset.maxkey === k) || null; }
// a view that can show right now: built-in, or a plugin section that is loaded and meant for the project in view
function dockAvail(k) { if (DOCK_VIEWS[k]) return true; const s = dockPlugSec(k); return !!(s && !s.hidden); }
function dockInfo(k) {
  if (DOCK_VIEWS[k]) { const v = DOCK_VIEWS[k]; return { el: $(v.el), name: v.name, short: v.short || v.name, icon: v.icon, side: v.side, size: v.size }; }
  const s = dockPlugSec(k), t = s && s.querySelector('.psec-t'), i = t && t.querySelector('i');
  const name = t ? t.textContent.trim() : 'Eklenti';
  return { el: s, name, short: name, icon: i ? i.className : 'fa-solid fa-puzzle-piece', side: (window.pluginHost && pluginHost.defaultCol && pluginHost.defaultCol(k)) || 'right', size: 1.5, plugin: true };
}
const dockKnown = () => [...Object.keys(DOCK_VIEWS), ...[...document.querySelectorAll('#claudeView .psec[data-maxkey]')].map(x => x.dataset.maxkey)];

/* ---------- state ---------- */
function dockDefault() {
  const side = (s, groups) => ({ open: true, cols: [{ w: DOCK_W[s], max: '', groups: groups.map(v => ({ views: [v], active: v, size: DOCK_VIEWS[v].size })) }] });
  return { left: side('left', ['side', 'usage']), right: side('right', ['queue', 'agents']), hidden: [], auto: [] };
}
// a clean copy of the stored layout: known shape, no duplicates, every known view placed or hidden
function dockState() {
  const raw = (CFG && CFG.settings.ui && CFG.settings.ui.dock) || null;
  const D = raw ? JSON.parse(JSON.stringify(raw)) : dockDefault();
  const seen = new Set();
  D.hidden = (Array.isArray(D.hidden) ? D.hidden : []).filter(k => typeof k === 'string' && !seen.has(k) && seen.add(k));
  for (const s of DOCK_SIDES) {
    const sd = D[s] = Object.assign({ open: true, cols: [] }, D[s] || {});
    sd.cols = (Array.isArray(sd.cols) ? sd.cols : []).map(c => ({
      w: Math.max(180, Math.min(700, +c.w || DOCK_W[s])), max: c.max || '',
      groups: (Array.isArray(c.groups) ? c.groups : []).map(g => {
        const views = (Array.isArray(g.views) ? g.views : []).filter(k => typeof k === 'string' && !seen.has(k) && seen.add(k));
        return { views, active: views.includes(g.active) ? g.active : views[0], size: +g.size > 0 ? +g.size : 1, folded: !!g.folded, fixed: !!g.fixed };
      }).filter(g => g.views.length),
    })).filter(c => c.groups.length);
  }
  // views never placed (a new plugin, a first start): a group of their own on their default side
  for (const k of dockKnown()) if (!seen.has(k)) { seen.add(k); dockAddGroup(D, k, dockInfo(k).side, 'end'); }
  D.auto = [...new Set(Array.isArray(D.auto) ? D.auto : [])].filter(k => dockFind(D, k));
  return D;
}
function dockSave(D) { DOCK_SIG = ''; return setCfg({ settings: { ui: { dock: D } } }).then(() => applyPanels()); }
function dockFind(D, k) {
  for (const s of DOCK_SIDES) D[s].cols.forEach((c, ci) => c.groups.forEach((g, gi) => { if (g.views.includes(k)) k = { side: s, ci, gi, col: c, group: g }; }));
  return typeof k === 'object' ? k : null;
}
function dockPrune(D) {
  for (const s of DOCK_SIDES) {
    D[s].cols.forEach(c => { c.groups = c.groups.filter(g => g.views.length); c.groups.forEach(g => { if (!g.views.includes(g.active)) g.active = g.views[0]; }); if (c.max && !c.groups.some(g => g.views.includes(c.max))) c.max = ''; });
    D[s].cols = D[s].cols.filter(c => c.groups.length);
  }
}
function dockRemove(D, k) {
  for (const s of DOCK_SIDES) D[s].cols.forEach(c => c.groups.forEach(g => { g.views = g.views.filter(x => x !== k); }));
  D.hidden = D.hidden.filter(x => x !== k);
  D.auto = (D.auto || []).filter(x => x !== k);
}
// a new group for a view on a side: 'end' = under the others in the innermost column, 'col' = a new full-height column at the window edge
function dockAddGroup(D, k, side, where) {
  const sd = D[side], g = { views: [k], active: k, size: dockInfo(k).size || 1 };
  if (where === 'col' || !sd.cols.length) sd.cols.unshift({ w: DOCK_W[side], max: '', groups: [g] });
  else sd.cols[sd.cols.length - 1].groups.push(g);
}
// does the view show right now (side visible, group visible, its tab active)?
function dockShowing(D, k) {
  if (D.auto.includes(k)) return DOCK_PEEK === k;
  const f = dockFind(D, k);
  return !!(f && f.group.active === k && !f.group.folded && D[f.side].open);
}
const dockDocked = (D, k) => dockAvail(k) && !D.auto.includes(k);

/* ---------- render ---------- */
function applyPanels() {
  if (!CFG) return;
  const D = dockState();
  const sig = JSON.stringify([D, DOCK_PEEK, dockKnown().map(k => k + (dockAvail(k) ? 1 : 0))]);
  if (sig !== DOCK_SIG) { DOCK_SIG = sig; dockRender(D); }
  renderPanelBadges();
  requestAnimationFrame(fitActive);
}
// header buttons a view lent to its group's header go back home before every render
const DOCK_ACTS = new Map(); // acts element -> its own panel header
function dockActsHome() { for (const [acts, home] of DOCK_ACTS) if (acts.parentElement !== home) home.appendChild(acts); }
function dockRender(D) {
  const keep = document.activeElement;
  dockActsHome();
  // park every view, then put each back where it belongs
  let park = document.getElementById('dockPark');
  if (!park) { park = document.createElement('div'); park.id = 'dockPark'; park.hidden = true; $('#claudeView').appendChild(park); }
  for (const [, el] of dockKnown().map(k => [k, dockInfo(k).el])) { if (el && el.parentElement !== park) park.appendChild(el); if (el) el.classList.add('dock-view'); }
  for (const side of DOCK_SIDES) {
    const sd = D[side], host = dockSideEl(side);
    host.className = `dock-side dock-${side}`;
    host.innerHTML = '';
    const cols = side === 'left' ? sd.cols : [...sd.cols].reverse(); // cols[0] sits at the window edge
    let any = false;
    cols.forEach(c => {
      const ci = sd.cols.indexOf(c);
      const groups = c.groups.map((g, gi) => ({ g, gi, views: g.views.filter(k => dockDocked(D, k)) })).filter(x => x.views.length);
      if (!groups.length) return;
      any = true;
      const col = document.createElement('div');
      col.className = 'dock-col'; col.style.width = c.w + 'px'; col.dataset.side = side; col.dataset.ci = ci;
      const maxed = c.max && groups.some(x => x.g.views.includes(c.max));
      const isMin = x => (maxed ? !x.g.views.includes(c.max) : x.g.folded);
      groups.forEach((x, n) => {
        if (n && !isMin(x) && !isMin(groups[n - 1])) { const sp = document.createElement('div'); sp.className = 'dg-split'; sp.dataset.side = side; sp.dataset.ci = ci; sp.dataset.gi = x.gi; col.appendChild(sp); }
        const active = x.views.includes(x.g.active) ? x.g.active : x.views[0];
        const min = isMin(x);
        const sec = document.createElement('section');
        sec.className = 'dock-group' + (min ? ' dg-min' : '') + (maxed && !min ? ' dg-max' : '');
        sec.dataset.side = side; sec.dataset.ci = ci; sec.dataset.gi = x.gi;
        sec.style.flex = min ? '0 0 auto' : `${x.g.size} 1 0`;
        // a content-sized view: as tall as its content unless the user made it taller (see dockFit)
        if (!min && DOCK_VIEWS[active] && DOCK_VIEWS[active].fit) {
          sec.classList.add('dg-fit');
          if (x.g.fixed) sec.dataset.fixed = '1'; else if (!maxed) sec.style.flex = '0 0 auto';
        }
        const tabs = x.views.map(k => { const inf = dockInfo(k); return `<button class="dg-tab ${k === active ? 'on' : ''}" draggable="true" data-dview="${dockEsc(k)}" title="${dockEsc(inf.name)}"><i class="${dockEsc(inf.icon)}"></i><span>${dockEsc(x.views.length > 1 ? inf.short : inf.name)}</span><b class="dg-n" data-badge="${dockEsc(k)}" hidden></b></button>`; }).join('');
        sec.innerHTML = `<header class="dg-head" draggable="true" data-dview="${dockEsc(active)}"><button class="dg-fold" data-dfold="${dockEsc(active)}" title="${min ? 'Aç' : 'Katla (yerinde kalır)'}" aria-expanded="${!min}"><i class="fa-solid fa-chevron-${min ? 'right' : 'down'}"></i></button><div class="dg-tabs ${x.views.length > 1 ? 'multi' : ''}">${tabs}</div><span class="dg-acts">`
          + `<button class="ghost icon" data-dpin="${dockEsc(active)}" title="Sabitlendi · otomatik gizlemek için tıkla"><i class="fa-solid fa-thumbtack dg-pin-on"></i></button>`
          + `<button class="ghost icon" data-dclose="${dockEsc(active)}" title="Kapat"><i class="fa-solid fa-xmark"></i></button></span></header><div class="dg-body"></div>`;
        const body = sec.querySelector('.dg-body');
        // (look the elements up before moving them: the group is not in the page yet)
        const els = x.views.map(k => [k, dockInfo(k).el]);
        els.forEach(([k, el]) => { if (!el) return; el.classList.toggle('dv-off', k !== active); body.appendChild(el); });
        dockLendActs(sec, (els.find(([k]) => k === active) || [])[1]);
        col.appendChild(sec);
      });
      const rz = document.createElement('div'); rz.className = 'dc-resize'; rz.dataset.side = side; rz.dataset.ci = ci;
      col.appendChild(rz);
      host.appendChild(col);
    });
    host.hidden = !any || !sd.open;
    dockRenderBar(D, side);
  }
  dockRenderPeek(D);
  dockFit();
  if (keep && keep !== document.body && keep.isConnected && document.activeElement !== keep) try { keep.focus({ preventScroll: true }); } catch (_) {}
  if (window.pluginHost && pluginHost.relayout) pluginHost.relayout();
}
// the auto-hidden view that was clicked: slides over the terminal next to its activity bar
function dockRenderPeek(D) {
  let p = document.getElementById('dockPeek');
  const k = DOCK_PEEK;
  if (!k || !D.auto.includes(k) || !dockAvail(k)) { if (p) p.remove(); DOCK_PEEK = ''; return; }
  const f = dockFind(D, k), inf = dockInfo(k);
  if (!p) { p = document.createElement('div'); p.id = 'dockPeek'; $('#claudeView').appendChild(p); }
  p.className = `dock-peek dock-${f.side}`;
  p.style.width = f.col.w + 'px';
  p.innerHTML = `<section class="dock-group dg-peek" data-side="${f.side}"><header class="dg-head" draggable="true" data-dview="${dockEsc(k)}"><div class="dg-tabs"><button class="dg-tab on" draggable="true" data-dview="${dockEsc(k)}" title="${dockEsc(inf.name)}"><i class="${dockEsc(inf.icon)}"></i><span>${dockEsc(inf.name)}</span><b class="dg-n" data-badge="${dockEsc(k)}" hidden></b></button></div>`
    + `<span class="dg-acts"><button class="ghost icon" data-dpin="${dockEsc(k)}" title="Otomatik gizli · sabitlemek (yerine geri koymak) için tıkla"><i class="fa-solid fa-thumbtack-slash"></i></button><button class="ghost icon" data-dclose="${dockEsc(k)}" title="Kapat"><i class="fa-solid fa-xmark"></i></button></span></header><div class="dg-body"></div></section>`;
  if (inf.el) { inf.el.classList.remove('dv-off'); p.querySelector('.dg-body').appendChild(inf.el); dockLendActs(p.querySelector('.dock-group'), inf.el); }
}
// content-sized groups: never shorter than their content (header + view)
function dockFit() {
  document.querySelectorAll('.dock-group.dg-fit').forEach(sec => {
    const v = sec.querySelector('.dg-body > .dock-view:not(.dv-off)');
    if (!v) return;
    sec.style.minHeight = (sec.querySelector('.dg-head').offsetHeight + v.scrollHeight) + 'px';
  });
}
function dockLendActs(sec, el) {
  const acts = el && el.querySelector(':scope > .panel-h > .ph-acts');
  if (!acts || !acts.querySelector('button')) return;
  DOCK_ACTS.set(acts, acts.parentElement);
  sec.querySelector('.dg-head').insertBefore(acts, sec.querySelector('.dg-acts'));
}
function dockRenderBar(D, side) {
  const bar = dockBarEl(side), sd = D[side];
  const views = sd.cols.flatMap(c => c.groups.flatMap(g => g.views)).filter(dockAvail);
  const hidden = D.hidden.filter(k => dockAvail(k) && dockInfo(k).side === side);
  bar.hidden = false;
  bar.className = `rail act-bar rail-${side}`;
  bar.innerHTML = views.map(k => { const inf = dockInfo(k), auto = D.auto.includes(k); return `<button class="act-btn ${dockShowing(D, k) ? 'on' : ''} ${auto ? 'auto' : ''}" draggable="true" data-dact="${dockEsc(k)}" title="${dockEsc(inf.name)}${auto ? ' (otomatik gizli)' : ''}"><i class="${dockEsc(inf.icon)}"></i><b class="rail-n" data-badge="${dockEsc(k)}" hidden></b></button>`; }).join('')
    + hidden.map(k => { const inf = dockInfo(k); return `<button class="act-btn off" data-dact="${dockEsc(k)}" title="${dockEsc(inf.name)} (kapalı · göstermek için tıkla)"><i class="${dockEsc(inf.icon)}"></i></button>`; }).join('');
}
function renderPanelBadges() {
  const n = typeof pendingCount === 'function' ? pendingCount() : 0, a = typeof shownAgents === 'function' ? shownAgents().length : 0;
  document.querySelectorAll('[data-badge="queue"]').forEach(b => { b.hidden = !n; b.textContent = n; b.classList.add('warn'); });
  document.querySelectorAll('[data-badge="agents"]').forEach(b => { b.hidden = !a; b.textContent = a; });
}

/* ---------- actions ---------- */
function showPanel(k) {
  const D = dockState();
  if (D.auto.includes(k)) { DOCK_PEEK = k; DOCK_SIG = ''; applyPanels(); return Promise.resolve(); }
  if (!dockFind(D, k)) { dockRemove(D, k); dockAddGroup(D, k, dockInfo(k).side, 'end'); }
  const f = dockFind(D, k);
  f.group.active = k; f.group.folded = false;
  if (f.col.max && !f.group.views.includes(f.col.max)) f.col.max = '';
  D[f.side].open = true;
  return dockSave(D);
}
function dockHide(k) {
  const D = dockState();
  dockRemove(D, k); D.hidden.push(k); dockPrune(D);
  return dockSave(D);
}
function dockToggleSide(side) {
  const D = dockState();
  D[side].open = !D[side].open;
  DOCK_PEEK = '';
  return dockSave(D);
}
// pin / unpin one view (Visual Studio auto-hide)
function dockPin(k) {
  const D = dockState(), f = dockFind(D, k);
  if (!f) return;
  if (D.auto.includes(k)) { D.auto = D.auto.filter(x => x !== k); f.group.active = k; D[f.side].open = true; }
  else D.auto.push(k);
  DOCK_PEEK = '';
  return dockSave(D);
}
// activity icon: show the view; clicking the one already showing closes the side
function dockActivate(k) {
  const D = dockState();
  if (D.hidden.includes(k)) return showPanel(k);
  if (D.auto.includes(k)) { DOCK_PEEK = DOCK_PEEK === k ? '' : k; DOCK_SIG = ''; applyPanels(); return Promise.resolve(); }
  const f = dockFind(D, k); if (!f) return showPanel(k);
  if (dockShowing(D, k)) return dockToggleSide(f.side);
  return showPanel(k);
}
function dockFold(k) {
  const D = dockState(), f = dockFind(D, k); if (!f) return;
  const max = f.group.views.includes(f.col.max);
  if (f.col.max) f.col.max = ''; // folding out of full height: back to the normal layout
  f.group.folded = max ? false : !f.group.folded;
  return dockSave(D);
}
function dockToggleMax(k) {
  const D = dockState(), f = dockFind(D, k); if (!f) return;
  f.col.max = f.group.views.includes(f.col.max) ? '' : f.group.active;
  f.group.folded = false;
  return dockSave(D);
}
function dockMoveSide(k) {
  const D = dockState(), f = dockFind(D, k); if (!f) return;
  const to = f.side === 'left' ? 'right' : 'left';
  dockRemove(D, k); dockPrune(D); dockAddGroup(D, k, to, 'end');
  D[to].open = true; DOCK_PEEK = '';
  return dockSave(D);
}
function dockReset() { DOCK_PEEK = ''; return setCfg({ settings: { ui: { dock: dockDefault() } } }).then(() => { DOCK_SIG = ''; applyPanels(); }); }
// the old panel API: 'left' / 'right' = a whole side, otherwise a view
function togglePanel(name) {
  if (S.mode === 'ide' && ['side', 'left', 'queue', 'right'].includes(name)) { toolbar(name === 'side' || name === 'left' ? 'ex' : 'panel'); return; }
  if (name === 'left' || name === 'right') return dockToggleSide(name);
  const D = dockState();
  return dockShowing(D, name) ? dockHide(name) : showPanel(name);
}

/* ---------- drag and drop ---------- */
const DDRAG = { view: '' };
// what dropping here would do, and the area to shade
function dockTarget(e) {
  const t = e.target && e.target.closest ? e.target : null;
  if (!t) return null;
  const rect = el => el.getBoundingClientRect();
  // the helper in the middle of the terminal: a side, as a new full-height panel or under the others
  const tile = t.closest('#dockHelper [data-dock]');
  if (tile) {
    const [side, where] = tile.dataset.dock.split(':');
    const host = dockSideEl(side), r = !host.hidden ? rect(host) : null, c = rect($('#claudeView .center'));
    let area;
    if (where === 'col') area = r ? { left: side === 'left' ? r.left : r.right - 260, top: r.top, width: 260, height: r.height } : { left: side === 'left' ? c.left : c.right - 280, top: c.top, width: 280, height: c.height };
    else area = r ? { left: r.left, top: r.bottom - r.height / 3, width: r.width, height: r.height / 3 } : { left: side === 'left' ? c.left : c.right - 280, top: c.top + c.height * 2 / 3, width: 280, height: c.height / 3 };
    return { op: where === 'col' ? 'col' : 'end', side, area, tile };
  }
  // an activity bar: under the others on that side
  const bar = t.closest('.act-bar');
  if (bar) return { op: 'end', side: bar.classList.contains('rail-left') ? 'left' : 'right', area: rect(bar) };
  // a group: the compass, or the part of the group under the pointer
  const grp = t.closest('.dock-group:not(.dg-peek)') || (t.closest('#grpCompass') && DDRAG.overGroup && DDRAG.overGroup.isConnected ? DDRAG.overGroup : null);
  if (!grp) return null;
  DDRAG.overGroup = grp;
  const r = rect(grp), ct = t.closest('#grpCompass [data-zone]');
  let zone = ct ? ct.dataset.zone : '';
  if (!zone) {
    if (t.closest('.dg-head')) zone = 'center';
    else {
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      zone = fy < 0.25 ? 'top' : fy > 0.75 ? 'bottom' : fx < 0.2 ? 'left' : fx > 0.8 ? 'right' : 'center';
    }
  }
  const area = zone === 'top' ? { left: r.left, top: r.top, width: r.width, height: r.height / 2 }
    : zone === 'bottom' ? { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 }
    : zone === 'left' ? { left: r.left, top: r.top, width: r.width / 2, height: r.height }
    : zone === 'right' ? { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height }
    : { left: r.left, top: r.top, width: r.width, height: r.height };
  return { op: zone, side: grp.dataset.side, ci: +grp.dataset.ci, gi: +grp.dataset.gi, area, grp, zone };
}
function dockMark(t) {
  let m = document.getElementById('secDrop');
  if (!m) { m = document.createElement('div'); m.id = 'secDrop'; m.className = 'sec-drop'; document.body.appendChild(m); }
  document.querySelectorAll('#dockHelper [data-dock].on, #grpCompass [data-zone].on').forEach(x => x.classList.remove('on'));
  // the compass follows the group under the pointer
  const cp = document.getElementById('grpCompass');
  if (cp) {
    if (t && t.grp) {
      const r = t.grp.getBoundingClientRect();
      cp.hidden = false;
      cp.style.left = (r.left + r.width / 2) + 'px'; cp.style.top = (r.top + r.height / 2) + 'px';
      const z = cp.querySelector(`[data-zone="${t.zone}"]`); if (z) z.classList.add('on');
    } else cp.hidden = true;
  }
  if (t && t.tile) t.tile.classList.add('on');
  if (!t) { m.hidden = true; return; }
  m.hidden = false;
  const a = t.area;
  Object.assign(m.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
}
function dockDragUi(on) {
  document.querySelectorAll('#dockHelper,#grpCompass').forEach(x => x.remove());
  document.body.classList.toggle('dock-dragging', on);
  if (!on) return;
  const c = $('#claudeView .center');
  if (c) {
    const tile = (side, where, label) => `<div class="dk-tile" data-dock="${side}:${where}" title="${label}"><span class="dk-ic ${side} ${where}"><b></b></span><small>${label}</small></div>`;
    const d = document.createElement('div');
    d.id = 'dockHelper';
    d.innerHTML = `<div class="dk-side">${tile('left', 'col', 'Sola tam boy')}${tile('left', 'end', 'Sol panele')}</div>`
      + '<div class="dk-mid"><i class="fa-solid fa-up-down-left-right"></i></div>'
      + `<div class="dk-side">${tile('right', 'col', 'Sağa tam boy')}${tile('right', 'end', 'Sağ panele')}</div>`;
    c.appendChild(d);
  }
  const cp = document.createElement('div');
  cp.id = 'grpCompass'; cp.hidden = true;
  cp.innerHTML = ['top', 'left', 'center', 'right', 'bottom'].map(z => `<div class="gc-t gc-${z}" data-zone="${z}" title="${{ top: 'Üstüne böl', left: 'Soluna böl', center: 'Sekme olarak ekle', right: 'Sağına böl', bottom: 'Altına böl' }[z]}"><b></b></div>`).join('');
  document.body.appendChild(cp);
}
function dockDrop(k, t) {
  const D = dockState();
  let side = t.side;
  if (t.op === 'col' || t.op === 'end') { dockRemove(D, k); dockPrune(D); dockAddGroup(D, k, side, t.op); }
  else {
    const col = D[side].cols[t.ci], grp = col && col.groups[t.gi];
    if (!grp) return;
    if (grp.views.length === 1 && grp.views[0] === k) return; // onto itself
    dockRemove(D, k);
    // the target group may have moved up after the dragged view left its own group
    dockPrune(D);
    const ci = D[side].cols.indexOf(col), gi = col.groups.indexOf(grp);
    if (ci < 0 || gi < 0) return;
    const g = { views: [k], active: k, size: grp.size / 2 };
    if (t.op === 'center') { grp.views.push(k); grp.active = k; }
    else if (t.op === 'top' || t.op === 'bottom') { grp.size /= 2; col.groups.splice(t.op === 'top' ? gi : gi + 1, 0, g); }
    else {
      // left / right on screen: cols[0] is at the window edge, so the right side counts the other way
      const outer = (side === 'left') === (t.op === 'left');
      g.size = 1;
      D[side].cols.splice(outer ? ci : ci + 1, 0, { w: Math.max(200, Math.round(col.w * 0.9)), max: '', groups: [g] });
    }
  }
  // a column showing one group at full height would hide the dropped view: show them all
  D[side].cols.forEach(c => { c.max = ''; });
  D[side].open = true; DOCK_PEEK = '';
  return dockSave(D);
}

/* ---------- resizing: column width and the split between two groups ---------- */
function dockResizeStart(e, h) {
  e.preventDefault();
  const D = dockState(), side = h.dataset.side, ci = +h.dataset.ci, col = D[side].cols[ci];
  if (!col) return;
  const colEl = h.closest('.dock-col');
  const x0 = e.clientX, y0 = e.clientY;
  let apply;
  if (h.classList.contains('dc-resize')) {
    const w0 = col.w;
    apply = ev => { col.w = Math.max(180, Math.min(700, w0 + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX))); colEl.style.width = col.w + 'px'; };
  } else {
    const gi = +h.dataset.gi; // the group under the splitter; the one above it is the previous shown one
    const below = h.nextElementSibling, above = h.previousElementSibling;
    const a = col.groups[+above.dataset.gi], b = col.groups[gi];
    const ha = above.getBoundingClientRect().height, hb = below.getBoundingClientRect().height;
    for (const [g, el, h, og, oh] of [[a, above, ha, b, hb], [b, below, hb, a, ha]]) {
      if (el.classList.contains('dg-fit') && !g.fixed) { g.fixed = true; g.size = og.size * h / Math.max(1, oh); el.dataset.fixed = '1'; }
    }
    const sum = a.size + b.size;
    apply = ev => {
      const d = ev.clientY - y0, na = Math.max(40, Math.min(ha + hb - 40, ha + d));
      a.size = sum * na / (ha + hb); b.size = sum - a.size;
      above.style.flex = `${a.size} 1 0`; below.style.flex = `${b.size} 1 0`;
    };
  }
  document.body.classList.add('dock-resizing');
  const move = ev => { apply(ev); fitActive(); };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('dock-resizing'); dockSave(D); };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

/* ---------- right-click menu (shown in the shared #ideMenu) ---------- */
function dockMenuHtml(ctx, it, sep) {
  const D = dockState(), f = dockFind(D, ctx.view);
  if (!f) return it('dshow', 'fa-solid fa-eye', `${dockEsc(dockInfo(ctx.view).name)} göster`) + sep + it('dreset', 'fa-solid fa-rotate-left', 'Varsayılan düzene dön');
  const sd = D[f.side], max = f.group.views.includes(f.col.max), auto = D.auto.includes(ctx.view);
  return it('dmax', 'fa-solid ' + (max ? 'fa-down-left-and-up-right-to-center' : 'fa-up-right-and-down-left-from-center'), max ? 'Eski boyutuna döndür' : 'Tam boy')
    + it('dfold', 'fa-solid ' + (f.group.folded ? 'fa-chevron-down' : 'fa-chevron-up'), f.group.folded ? 'Aç' : 'Katla (yerinde kalır)')
    + it('dmove', 'fa-solid ' + (f.side === 'left' ? 'fa-arrow-right' : 'fa-arrow-left'), f.side === 'left' ? 'Sağ panele taşı' : 'Sol panele taşı')
    + it('dclose', 'fa-solid fa-xmark', 'Kapat')
    + sep + it('dpin', 'fa-solid ' + (auto ? 'fa-thumbtack' : 'fa-thumbtack-slash'), auto ? 'Sabitle (yerine geri koy)' : 'Otomatik gizle')
    + it('dside', 'fa-solid ' + (f.side === 'left' ? 'fa-angles-left' : 'fa-angles-right'), (f.side === 'left' ? 'Sol' : 'Sağ') + ' paneli kapat', f.side === 'left' ? 'Ctrl+Shift+E' : 'Ctrl+Shift+D')
    + (D.hidden.length ? sep + D.hidden.filter(dockAvail).map(k => it('dshow:' + k, 'fa-solid fa-eye', `${dockEsc(dockInfo(k).name)} göster`)).join('') : '')
    + sep + it('dreset', 'fa-solid fa-rotate-left', 'Varsayılan düzene dön');
}
function dockMenuAction(act, ctx) {
  const k = ctx.view, D = dockState(), f = dockFind(D, k);
  if (act === 'dmax') dockToggleMax(k);
  else if (act === 'dfold') dockFold(k);
  else if (act === 'dmove') dockMoveSide(k);
  else if (act === 'dclose') dockHide(k);
  else if (act === 'dpin') dockPin(k);
  else if (act === 'dside' && f) { DOCK_PEEK = ''; D[f.side].open = false; dockSave(D); }
  else if (act === 'dshow') showPanel(k);
  else if (act.startsWith('dshow:')) showPanel(act.slice(6));
  else if (act === 'dreset') dockReset();
}

/* ---------- events ---------- */
function bindDock() {
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-dact],[data-dpin],[data-dclose],[data-dfold],.dg-tab') || (e.target.closest('.dg-head') && !e.target.closest('button,.ph-acts') ? e.target.closest('.dg-head') : null);
    if (!b) return;
    e.stopImmediatePropagation();
    const grp = b.closest('.dock-group:not(.dg-peek)');
    const single = !!grp && !grp.querySelector('.dg-tabs.multi') && (b.classList.contains('dg-tab') || b.classList.contains('dg-head'));
    if (b.dataset.dfold) dockFold(b.dataset.dfold);
    else if (single) dockFold(b.dataset.dview);
    else if (b.dataset.dact) dockActivate(b.dataset.dact);
    else if (b.dataset.dpin) dockPin(b.dataset.dpin);
    else if (b.dataset.dclose) dockHide(b.dataset.dclose);
    else if (b.dataset.dview) showPanel(b.dataset.dview);
  });
  document.addEventListener('dblclick', e => {
    const h = e.target.closest('.dg-head');
    if (h && !e.target.closest('.dg-acts')) dockToggleMax(h.dataset.dview);
  });
  document.addEventListener('mousedown', e => {
    const h = e.target.closest('.dc-resize,.dg-split');
    if (h && e.button === 0) { dockResizeStart(e, h); return; }
    // an auto-hidden view slides back when you click elsewhere
    if (DOCK_PEEK && !e.target.closest('#dockPeek,.act-btn,#ideMenu,.ui-dlg-bg,.ui-tip,#startPanel')) { DOCK_PEEK = ''; DOCK_SIG = ''; applyPanels(); }
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && DOCK_PEEK) { DOCK_PEEK = ''; DOCK_SIG = ''; applyPanels(); } });
  document.addEventListener('dragstart', e => {
    const s = e.target.closest && e.target.closest('.dg-tab,.dg-head,.act-btn');
    if (!s) return;
    const k = s.dataset.dview || s.dataset.dact;
    if (!k) return;
    DDRAG.view = k;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-vox-view', k);
    // after the browser took the drag image
    setTimeout(() => { if (DDRAG.view) dockDragUi(true); }, 0);
  });
  document.addEventListener('dragover', e => {
    if (!DDRAG.view) return;
    const t = dockTarget(e);
    dockMark(t);
    if (t) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  });
  document.addEventListener('drop', e => {
    if (!DDRAG.view) return;
    const t = dockTarget(e), k = DDRAG.view;
    dockEndDrag();
    if (t) { e.preventDefault(); dockDrop(k, t); }
  });
  document.addEventListener('dragend', dockEndDrag);
  // the usage view re-renders (tokens / plan limits): its group follows its content
  const ub = document.getElementById('usageBody');
  if (ub) new MutationObserver(() => requestAnimationFrame(dockFit)).observe(ub, { childList: true, subtree: true });
  document.addEventListener('contextmenu', e => {
    const s = e.target.closest('.dg-tab,.dg-head,.act-btn');
    if (!s) return;
    const k = s.dataset.dview || s.dataset.dact;
    if (k) openIdeMenu(e, { kind: 'dock', view: k });
  });
}
function dockEndDrag() { DDRAG.view = ''; DDRAG.overGroup = null; dockMark(null); dockDragUi(false); }
