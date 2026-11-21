/* VoxStorm IDE: DB panel. A "DB" view in the explorer (saved connections → databases → tables)
   and a query drawer above the Claude panel (scratch SQL + result grid). Runs the selected SQL of
   the code editor against the chosen connection (Ctrl+Shift+Enter).
   The connection state, dialogs and the result grid come from db.js (window.dbApi); queries run in
   their own db:run session id so they never share a session with DB-mode tabs.
   Uses globals from app.js: $, esc, toast, IDE, ist, extOf, setCfg, openFile, SHORTCUTS. */
/* global api, CodeMirror, dbApi */
(() => {
  'use strict';
  const TAB = 'ide-' + Math.random().toString(36).slice(2, 10); // db:run session, separate from DB-mode tabs
  const fmtN = n => Number(n || 0).toLocaleString(I18N.locale());
  const fmtMs = ms => (ms < 1000 ? ms + ' ms' : __('{n} sn', { n: (ms / 1000).toLocaleString(I18N.locale(), { maximumFractionDigits: 2 }) }));
  const errText = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const inv = async (ch, ...a) => { try { return await api.invoke(ch, ...a); } catch (e) { return { error: errText(e) }; } };
  const byId = id => document.getElementById(id);

  const Q = {
    side: false, drawer: false, loaded: false, filter: '', selKey: '',
    running: false, started: 0, connId: '', db: '', results: [], messages: [], ms: null, view: 'sql', offset: 0, src: null, last: null,
    cm: null, tick: null, err: null,
  };
  // persisted with the IDE layout (config ide.ui.db)
  const st = () => IDE.ui.db || (IDE.ui.db = { connId: '', db: '', h: 240, open: false, sql: '' });
  let saveT = null;
  function persist() { clearTimeout(saveT); saveT = setTimeout(() => setCfg({ ide: { ui: { db: st() } } }), 500); }
  const target = () => dbApi.conn(st().connId);

  async function ensureLoaded() {
    if (Q.loaded) return;
    Q.loaded = true;
    dbApi.watchTree(() => { renderTree(); renderTarget(); renderHead(); });
    await dbApi.load();
    if (st().connId && !target()) { st().connId = ''; st().db = ''; }
    renderTree(); renderTarget(); renderHead();
  }
  // connect: false when the caller connects anyway (opening the node in the tree)
  function setTarget(connId, db, connect = true) {
    const c = dbApi.conn(connId); if (!c) return;
    const changed = st().connId !== c.id || st().db !== (db || '');
    st().connId = c.id; st().db = db != null ? db : (c.database || '');
    if (Q.cm) Q.cm.setOption('mode', dbApi.CM_MODE[c.type] || 'text/x-sql');
    const live = dbApi.live(c.id);
    if (connect && (!live || !live.status || live.status === 'idle')) dbApi.connect(c.id, true);
    if (changed) persist();
    renderTarget(); renderHead();
  }

  /* ---------------- explorer view ---------------- */
  function buildSide() {
    const el = byId('idbSide');
    el.innerHTML = `
      <div class="idb-bar">
        <div class="db-search"><i class="fa-solid fa-magnifying-glass"></i><input id="idbFilter" placeholder="${esc(__('Bağlantı, tablo ara…'))}" spellcheck="false" autocomplete="off" aria-label="${esc(__('Veritabanında ara'))}"></div>
        <button class="db-ib" data-idb="newConn" title="${esc(__('Yeni bağlantı'))}" aria-label="${esc(__('Yeni bağlantı'))}"><i class="fa-solid fa-plus"></i></button>
        <button class="db-ib" data-idb="reload" title="${esc(__('Bağlantı listesini yenile'))}" aria-label="${esc(__('Bağlantı listesini yenile'))}"><i class="fa-solid fa-arrows-rotate"></i></button>
        <button class="db-ib" data-idb="dbmode" title="${esc(__('DB modunda aç'))}" aria-label="${esc(__('DB modunda aç'))}"><i class="fa-solid fa-up-right-from-square"></i></button>
      </div>
      <div class="idb-tgt" id="idbTgt"></div>
      <div class="db-list" id="idbTree" tabindex="0" role="tree" aria-label="${esc(__('Veritabanı bağlantıları'))}"></div>
      <div class="idb-hint">${esc(__('Tıkla: sorgu hedefi · Çift tık: adı düzenleyiciye ekle · Sağ tık: işlemler'))}</div>`;
    el.addEventListener('click', onSideClick);
    el.addEventListener('dblclick', onSideDbl);
    el.addEventListener('contextmenu', onSideMenu);
    byId('idbTree').addEventListener('keydown', treeKey);
    const f = byId('idbFilter');
    f.addEventListener('input', () => { Q.filter = f.value; renderTree(); });
    f.addEventListener('keydown', e => { if (e.key === 'Escape' && f.value) { e.stopPropagation(); f.value = ''; Q.filter = ''; renderTree(); } });
  }
  function renderTree() {
    const el = byId('idbTree'); if (!el || !Q.side) return;
    const top = el.scrollTop;
    el.innerHTML = dbApi.treeHtml(Q.filter);
    if (Q.selKey) { const n = [...el.querySelectorAll('.db-node[data-key]')].find(x => x.dataset.key === Q.selKey); if (n) n.classList.add('cur'); }
    el.scrollTop = top;
  }
  function renderTarget() {
    const el = byId('idbTgt'); if (!el) return;
    const c = target(), live = c && dbApi.live(c.id);
    el.innerHTML = c
      ? `<span class="db-cdot db-c-${c.color || 'none'}${live && live.status === 'ok' ? ' on' : ''}"></span><span class="idb-tn" title="${esc(__('Ctrl+Shift+Enter bu bağlantıda çalışır'))}"><b>${esc(c.name || c.host)}</b>${st().db ? ' / ' + esc(st().db) : ''}</span><button class="db-link" data-idb="drawer">${esc(Q.drawer ? __('Paneli gizle') : __('Sorgu paneli'))}</button>`
      : `<span class="db-muted">${esc(__('Sorgu hedefi yok: bir bağlantıya ya da veritabanına tıkla.'))}</span>`;
  }
  function selectNode(n) {
    byId('idbTree').querySelectorAll('.cur').forEach(x => x.classList.remove('cur'));
    n.classList.add('cur'); Q.selKey = n.dataset.key;
    n.scrollIntoView({ block: 'nearest' });
  }
  const isCol = key => key.split(':').length > 6;
  const isLeaf = (key, n) => n.t === 'o' && (isCol(key) || n.kind === 'procs' || n.kind === 'funcs');
  function onSideClick(e) {
    const a = e.target.closest('[data-idb],[data-act]');
    if (a) {
      const act = a.dataset.idb || a.dataset.act;
      if (act === 'newConn') dbApi.editConn();
      else if (act === 'reload') dbApi.load();
      else if (act === 'dbmode') dbApi.openInDbMode(Q.selKey ? { key: Q.selKey } : {});
      else if (act === 'drawer') showDrawer(!Q.drawer);
      return;
    }
    const node = e.target.closest('.db-node[data-key]');
    if (!node || e.detail !== 1) return;
    const key = node.dataset.key, n = dbApi.parseKey(key);
    selectNode(node);
    const opening = !isLeaf(key, n) && !dbApi.isOpen(key);
    setTarget(n.id, n.t === 'c' ? (st().connId === n.id ? st().db : undefined) : n.db, !opening);
    if (!isLeaf(key, n)) dbApi.toggle(key);
  }
  // the name as it goes into code
  function nameOf(key) {
    const n = dbApi.parseKey(key), c = dbApi.conn(n.id); if (!c) return '';
    if (n.t === 'd') return dbApi.qi(c.type, n.db);
    if (n.t === 's') return dbApi.qi(c.type, n.schema);
    if (n.t === 'o' && isCol(key)) return dbApi.qi(c.type, decodeURIComponent(key.split(':')[6]));
    if (n.t === 'o') return dbApi.full(c.type, n);
    return '';
  }
  function insertText(text) {
    if (!text) return;
    const cm = IDE.cm, f = IDE.files[ist().file];
    if (!f || !f.doc || cm.getWrapperElement().hidden) { dbApi.copyText(text, __('Açık dosya yok; panoya kopyalandı')); return; }
    cm.replaceSelection(text);
    cm.focus();
  }
  function onSideDbl(e) {
    const node = e.target.closest('.db-node[data-key]'); if (!node) return;
    const key = node.dataset.key, n = dbApi.parseKey(key);
    if (n.t === 'c' || n.t === 'k') return;
    insertText(nameOf(key));
  }
  async function onSideMenu(e) {
    const node = e.target.closest('.db-node[data-key]'); if (!node) return;
    e.preventDefault();
    selectNode(node);
    const key = node.dataset.key, n = dbApi.parseKey(key), c = dbApi.conn(n.id); if (!c) return;
    const live = dbApi.live(n.id), on = live && live.status === 'ok';
    const toDb = ['dbmode', __('DB modunda aç'), 'fa-up-right-from-square'];
    let items;
    if (n.t === 'c') items = [on ? ['disconnect', __('Bağlantıyı kes'), 'fa-plug-circle-xmark'] : ['connect', __('Bağlan'), 'fa-plug'], ['target', __('Sorgu hedefi yap'), 'fa-crosshairs'], ['refresh', __('Yenile'), 'fa-rotate-right', !on], '-', ['edit', __('Düzenle…'), 'fa-pen'], toDb];
    else if (n.t === 'd' || n.t === 's') items = [['target', __('Sorgu hedefi yap'), 'fa-crosshairs'], ['insert', __('Adı düzenleyiciye ekle'), 'fa-i-cursor'], ['copy', __('Adı kopyala'), 'fa-copy'], ...(n.t === 'd' ? [['refresh', __('Yenile'), 'fa-rotate-right']] : []), '-', toDb];
    else if (n.t === 'k') items = [['refresh', __('Yenile'), 'fa-rotate-right']];
    else if (isCol(key)) items = [['insert', __('Adı düzenleyiciye ekle'), 'fa-i-cursor'], ['copy', __('Adı kopyala'), 'fa-copy']];
    else if (n.kind === 'tables' || n.kind === 'views') {
      items = [['top', __('İlk 100 satırı göster'), 'fa-table-list'], ['count', __('Satırları say'), 'fa-hashtag'], '-',
        ['insert', __('Tam adı düzenleyiciye ekle'), 'fa-i-cursor'], ['sel', __('SELECT şablonunu ekle'), 'fa-magnifying-glass'], ['copy', __('Adı kopyala'), 'fa-copy'], ['refresh', __('Sütunları yenile'), 'fa-rotate-right'], '-', toDb];
    } else items = [['exec', n.kind === 'procs' ? __('Çalıştırma şablonunu ekle') : __('Çağırma şablonunu ekle'), 'fa-play'], ['insert', __('Tam adı düzenleyiciye ekle'), 'fa-i-cursor'], ['copy', __('Adı kopyala'), 'fa-copy']];
    const a = await dbApi.menu(e.clientX, e.clientY, items);
    if (!a) return;
    const obj = { ...n };
    if (a === 'connect' || a === 'disconnect' || a === 'refresh' || a === 'edit') { dbApi.nodeAction(a, key); return; }
    if (a === 'target') { setTarget(n.id, n.t === 'c' ? undefined : n.db); showDrawer(true); }
    else if (a === 'insert') insertText(nameOf(key));
    else if (a === 'copy') dbApi.copyText(n.t === 'd' ? n.db : n.t === 's' ? n.schema : isCol(key) ? decodeURIComponent(key.split(':')[6]) : n.name, __('Ad kopyalandı'));
    else if (a === 'dbmode') dbApi.openInDbMode({ key });
    else if (a === 'top' || a === 'count') {
      setTarget(n.id, n.db);
      const sql = a === 'top' ? dbApi.topSql(c.type, obj) : `SELECT COUNT(*) AS satir_sayisi\nFROM ${dbApi.full(c.type, obj)};`;
      runSql(sql, { kind: 'gen' }, 0);
    } else if (a === 'sel') { const cols = await dbApi.columnsOf(obj); insertText(dbApi.selectSql(c.type, obj, cols)); }
    else if (a === 'exec') insertText(dbApi.execSql(c.type, obj));
  }
  function treeKey(e) {
    const items = [...byId('idbTree').querySelectorAll('.db-node[data-key]')];
    let i = items.findIndex(x => x.classList.contains('cur'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); if (items[i]) selectNode(items[i]); return; }
    const cur = items[i]; if (!cur) return;
    const key = cur.dataset.key, n = dbApi.parseKey(key);
    if (e.key === 'Enter') { e.preventDefault(); if (n.t === 'c' || n.t === 'k') dbApi.toggle(key); else insertText(nameOf(key)); }
    else if ((e.key === 'ArrowRight' && !dbApi.isOpen(key)) || (e.key === 'ArrowLeft' && dbApi.isOpen(key))) { if (!isLeaf(key, n)) { e.preventDefault(); dbApi.toggle(key); } }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const b = cur.getBoundingClientRect(); onSideMenu({ target: cur, preventDefault() {}, clientX: b.left + 40, clientY: b.bottom }); }
  }
  // called by app.js setExView
  async function showSide(on) {
    Q.side = !!on;
    const el = byId('idbSide'); if (!el) return;
    el.hidden = !on;
    if (!on) return;
    if (!el.firstChild) buildSide();
    await ensureLoaded();
    renderTree(); renderTarget();
  }

  /* ---------------- query drawer ---------------- */
  function buildDrawer() {
    const el = byId('idbRes');
    el.innerHTML = `
      <div class="idb-grip" title="${esc(__('Sürükle: boyutu değiştir · Çift tık: varsayılan boyut'))}"></div>
      <div class="idb-h">
        <div class="db-rtabs idb-tabs" id="idbTabs" role="tablist" aria-label="${esc(__('DB sonuçları'))}"></div>
        <div class="idb-acts">
          <span class="db-cdot" id="idbDot"></span>
          <select id="idbConn" aria-label="${esc(__('Bağlantı'))}" title="${esc(__('Sorguların çalışacağı bağlantı'))}"></select>
          <select id="idbDb" aria-label="${esc(__('Veritabanı'))}" title="${esc(__('Veritabanı'))}"></select>
          <button class="db-run" data-idb="run" id="idbRun"><i class="fa-solid fa-play"></i>${esc(__('Çalıştır'))}</button>
          <button class="db-tb danger" data-idb="cancel" title="${esc(__('Sorguyu iptal et'))}" hidden><i class="fa-solid fa-stop"></i>${esc(__('İptal'))}</button>
          <button class="db-ib" data-idb="todb" title="${esc(__('Sorguyu DB modunda aç'))}" aria-label="${esc(__('Sorguyu DB modunda aç'))}"><i class="fa-solid fa-up-right-from-square"></i></button>
          <button class="db-ib" data-idb="hide" title="${esc(__('DB panelini gizle'))}" aria-label="${esc(__('DB panelini gizle'))}"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
      <div class="idb-ed" id="idbEd"></div>
      <div class="db-rbody" id="idbBody"></div>`;
    Q.cm = CodeMirror(byId('idbEd'), {
      theme: 'claudelot', mode: (target() && dbApi.CM_MODE[target().type]) || 'text/x-sql', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true,
      indentUnit: 2, tabSize: 2, value: st().sql || '',
      extraKeys: cmKeys({ 'Ctrl-Enter': () => runScratch(false), 'Ctrl-Shift-Enter': () => runScratch(true), Tab: c => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ')), 'Shift-Tab': c => c.indentSelection('subtract') }),
    });
    Q.cm.on('changes', () => { st().sql = Q.cm.getValue().slice(0, 100000); persist(); });
    el.addEventListener('click', onDrawerClick);
    el.addEventListener('change', e => {
      if (e.target.id === 'idbConn') { if (e.target.value) setTarget(e.target.value); else { st().connId = ''; st().db = ''; persist(); renderTarget(); renderHead(); } }
      else if (e.target.id === 'idbDb') { st().db = e.target.value; persist(); renderTarget(); }
    });
    el.addEventListener('focusin', e => {
      if (e.target.id !== 'idbDb') return;
      const c = target(), live = c && dbApi.live(c.id);
      if (c && (!live || live.status !== 'ok')) dbApi.connect(c.id, false);
    });
    dbApi.bindGrid(byId('idbBody'));
    // drag the top edge to resize
    const grip = el.querySelector('.idb-grip');
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const y0 = e.clientY, h0 = el.offsetHeight, max = Math.max(160, el.parentElement.clientHeight - 140);
      grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
      const mv = ev => { st().h = Math.round(Math.max(120, Math.min(max, h0 + y0 - ev.clientY))); el.style.setProperty('--dbh', st().h + 'px'); };
      const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); grip.classList.remove('drag'); persist(); refresh(); };
      grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => { st().h = 240; el.style.setProperty('--dbh', '240px'); persist(); refresh(); });
  }
  async function showDrawer(on, quiet) {
    Q.drawer = !!on;
    const el = byId('idbRes'); if (!el) return;
    if (on && !el.firstChild) buildDrawer();
    el.hidden = !on;
    el.style.setProperty('--dbh', (st().h || 240) + 'px');
    byId('tbDb').setAttribute('aria-pressed', !!on);
    if (st().open !== !!on) { st().open = !!on; persist(); }
    renderTarget();
    if (!on) return;
    await ensureLoaded();
    const c = target();
    if (c && !quiet && !dbApi.live(c.id)) dbApi.connect(c.id, true); // fills the database list
    render();
    if (!quiet && Q.view === 'sql') requestAnimationFrame(() => Q.cm.focus());
  }
  function refresh() {
    if (!Q.drawer || !Q.cm) return;
    requestAnimationFrame(() => {
      Q.cm.refresh();
      const g = byId('idbBody').querySelector('.db-grid');
      if (g && Q.view !== 'sql') render();
      if (window.IDE && IDE.cm) IDE.cm.refresh();
    });
  }
  function renderHead() {
    const cs = byId('idbConn'); if (!cs) return;
    const c = target(), live = c && dbApi.live(c.id);
    if (document.activeElement !== cs) cs.innerHTML = `<option value="">${esc(__('Bağlantı seç…'))}</option>` + dbApi.conns().map(x => `<option value="${esc(x.id)}"${c && x.id === c.id ? ' selected' : ''}>${esc(x.name || x.host)} (${esc(dbApi.TYPE_NAME[x.type])})</option>`).join('');
    const ds = byId('idbDb');
    if (document.activeElement !== ds) {
      const names = ((live && live.dbs) || []).map(d => d.name);
      if (st().db && !names.includes(st().db)) names.unshift(st().db);
      ds.innerHTML = (c ? `<option value="">${esc(c.type === 'pg' ? __('postgres (varsayılan)') : __('Varsayılan veritabanı'))}</option>` : '<option value="">—</option>') + names.map(n => `<option${n === st().db ? ' selected' : ''}>${esc(n)}</option>`).join('');
      ds.disabled = !c;
    }
    byId('idbDot').className = 'db-cdot db-c-' + ((c && c.color) || 'none') + (live && live.status === 'ok' ? ' on' : '');
    const run = byId('idbRun');
    run.hidden = Q.running;
    run.innerHTML = Q.view === 'sql' || !Q.last ? `<i class="fa-solid fa-play"></i>${esc(__('Çalıştır'))}` : `<i class="fa-solid fa-rotate-right"></i>${esc(__('Yeniden çalıştır'))}`;
    run.title = Q.view === 'sql' || !Q.last ? __('Sorgu kutusunu çalıştır: seçili kısım ya da tamamı (Ctrl+Enter)\nDüzenleyicide: seçili SQL ya da .sql dosyasında imleçteki deyim (Ctrl+Shift+Enter)') : __('Son sorguyu yeniden çalıştır');
    byId('idbRes').querySelector('[data-idb="cancel"]').hidden = !Q.running;
  }
  function render() {
    if (!Q.drawer || !Q.cm) return;
    renderHead();
    const errs = Q.messages.filter(m => m.type === 'error').length;
    byId('idbTabs').innerHTML = `<button class="db-rtab${Q.view === 'sql' ? ' on' : ''}" data-iview="sql" role="tab"><i class="fa-solid fa-pen-to-square"></i>${esc(__('Sorgu'))}</button>`
      + Q.results.map((r, i) => `<button class="db-rtab${Q.view === i ? ' on' : ''}" data-iview="${i}" role="tab"><i class="fa-solid fa-table-list"></i>${esc(__('Sonuç {i}', { i: i + 1 }))}<small>${fmtN(r.total)}</small></button>`).join('')
      + (Q.messages.length || Q.ms != null || Q.running ? `<button class="db-rtab${Q.view === 'msg' ? ' on' : ''}${errs ? ' err' : ''}" data-iview="msg" role="tab"><i class="fa-solid ${Q.running ? 'fa-spinner fa-spin' : errs ? 'fa-circle-exclamation' : 'fa-message'}"></i>${esc(__('Mesajlar'))}${Q.messages.length ? `<small>${Q.messages.length}</small>` : ''}</button>` : '')
      + (Q.running ? `<span class="idb-time">${fmtMs(Date.now() - Q.started)}</span>` : Q.ms != null ? `<span class="idb-time">${fmtMs(Q.ms)}</span>` : '');
    const ed = byId('idbEd'), body = byId('idbBody');
    ed.hidden = Q.view !== 'sql'; body.hidden = Q.view === 'sql';
    if (Q.view === 'sql') { Q.cm.refresh(); return; }
    if (Q.running && (Q.view === 'msg' || !Q.results[Q.view])) { body.innerHTML = `<div class="db-wait"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(__('Sorgu çalışıyor…'))} <button class="btn" data-idb="cancel">${esc(__('İptal et'))}</button></div>`; return; }
    if (Q.view === 'msg' || !Q.results[Q.view]) {
      body.innerHTML = `<div class="db-msgs">${Q.messages.map(m => `<div class="db-msg ${m.type}"${m.line && Q.src && Q.src.kind !== 'gen' ? ` data-line="${m.line}" title="${esc(__('Satıra git'))}"` : ''}><i class="fa-solid ${m.type === 'error' ? 'fa-circle-xmark' : m.type === 'cancel' ? 'fa-ban' : m.type === 'rows' || m.type === 'ok' ? 'fa-check' : 'fa-circle-info'}"></i><span>${m.line ? `<b>${esc(__('Satır {line}:', { line: (Q.offset || 0) + m.line }))}</b> ` : ''}${esc(m.text)}</span></div>`).join('')}`
        + (Q.ms != null ? `<div class="db-msg muted"><i class="fa-regular fa-clock"></i><span>${esc(Q.results.length ? __('Süre: {time} · {n} sonuç kümesi', { time: fmtMs(Q.ms), n: Q.results.length }) : __('Süre: {time}', { time: fmtMs(Q.ms) }))}</span></div>` : '') + '</div>';
      return;
    }
    dbApi.renderGrid(Q, Q.results[Q.view], body);
  }
  async function onDrawerClick(e) {
    const v = e.target.closest('[data-iview]');
    if (v) { Q.view = v.dataset.iview === 'sql' || v.dataset.iview === 'msg' ? v.dataset.iview : +v.dataset.iview; render(); if (Q.view === 'sql') Q.cm.focus(); return; }
    const ml = e.target.closest('.db-msg[data-line]');
    if (ml) { gotoLine((Q.offset || 0) + +ml.dataset.line); return; }
    const a = e.target.closest('[data-idb],[data-act]'); if (!a) return;
    const act = a.dataset.idb || a.dataset.act;
    const r = typeof Q.view === 'number' ? Q.results[Q.view] : null;
    if (act === 'run') { if (Q.view !== 'sql' && Q.last) runSql(Q.last.sql, Q.last.src, Q.last.offset); else runScratch(false); }
    else if (act === 'cancel') { if (Q.running) { await inv('db:cancel', TAB); toast(__('İptal isteği gönderildi')); } }
    else if (act === 'hide') showDrawer(false);
    else if (act === 'todb') {
      const c = target();
      const sql = Q.view === 'sql' || !Q.last ? Q.cm.getValue() : Q.last.sql;
      dbApi.openInDbMode({ sql, connId: c ? c.id : '', db: st().db });
    } else if (r && (act === 'more' || act === 'moreAll')) { await dbApi.fetchMore(r, act === 'moreAll'); render(); }
    else if (r && act === 'copyAll') { const s = r.sel; r.sel = { r0: 0, r1: r.shown - 1, c0: 0, c1: r.columns.length - 1 }; dbApi.copySel(r, true); r.sel = s; }
    else if (r && act === 'csv') {
      const m = await dbApi.menu(e.clientX, e.clientY, [['c', __('CSV (virgülle ayrılmış)'), 'fa-file-csv'], ['s', __('CSV (noktalı virgül, Türkçe Excel için)'), 'fa-file-excel'], ['t', __('TSV (sekmeyle ayrılmış)'), 'fa-file-lines']]);
      if (m) dbApi.exportResult(r, m === 's' ? ';' : m === 't' ? '\t' : ',', 'sorgu');
    }
  }
  function gotoLine(line) {
    const src = Q.src; if (!src) return;
    if (src.kind === 'scratch') {
      Q.view = 'sql'; render();
      const l = Math.max(0, Math.min(Q.cm.lastLine(), line - 1));
      Q.cm.setCursor({ line: l, ch: 0 }); Q.cm.scrollIntoView({ line: l, ch: 0 }, 60); Q.cm.focus();
    } else if (src.kind === 'editor' && src.file) openFile(src.file, { line });
  }

  /* ---------------- running ---------------- */
  function runScratch(stmt) {
    if (!Q.cm) return;
    let sql, offset = 0;
    if (stmt) {
      const x = dbApi.statementAt(Q.cm);
      if (!x || !x.sql.trim()) { toast(__('Çalıştırılacak deyim yok')); return; }
      sql = x.sql; offset = x.from;
      Q.cm.setSelection({ line: x.from, ch: 0 }, { line: x.to, ch: Q.cm.getLine(x.to).length });
    } else if (Q.cm.somethingSelected()) { sql = Q.cm.getSelection(); offset = Q.cm.getCursor('from').line; } else sql = Q.cm.getValue();
    if (!sql.trim()) { toast(__('Çalıştırılacak sorgu yok'), __('Sorgu kutusuna SQL yaz.')); return; }
    runSql(sql, { kind: 'scratch', doc: Q.cm.getDoc() }, offset);
  }
  // the code editor: the selection, or the statement under the cursor in a .sql file
  function runEditor() {
    const cm = IDE.cm, fp = ist().file, f = fp && IDE.files[fp];
    if (!f || !f.doc || cm.getWrapperElement().hidden) {
      if (Q.drawer) { runScratch(false); return; }
      toast(__('Açık dosya yok'), __('Bir .sql dosyası aç ya da DB panelindeki sorgu kutusunu kullan.')); showDrawer(true); return;
    }
    let sql, offset = 0;
    if (cm.somethingSelected()) { sql = cm.getSelection(); offset = cm.getCursor('from').line; }
    else if (extOf(fp) === 'sql') {
      const x = dbApi.statementAt(cm);
      if (!x || !x.sql.trim()) { toast(__('Çalıştırılacak deyim yok')); return; }
      sql = x.sql; offset = x.from;
      cm.setSelection({ line: x.from, ch: 0 }, { line: x.to, ch: cm.getLine(x.to).length });
    } else { toast(__("Önce çalıştırılacak SQL'i seç"), __('SQL dosyalarında seçim yoksa imlecin bulunduğu deyim çalışır.')); return; }
    if (!sql.trim()) { toast(__('Çalıştırılacak sorgu yok')); return; }
    runSql(sql, { kind: 'editor', file: fp, doc: f.doc }, offset);
  }
  function runSmart() {
    const a = document.activeElement;
    if (a && a.closest && a.closest('#idbEd')) { runScratch(true); return; }
    // Ctrl+Shift+Enter is also "insert line above" (Seçim menüsü): outside .sql files it runs SQL
    // only when something is selected and a connection is chosen
    const cm = IDE.cm, fp = ist().file;
    const inEditor = cm && !cm.getWrapperElement().hidden && cm.hasFocus();
    if (inEditor && fp && extOf(fp) !== 'sql' && !(cm.somethingSelected() && target())) { cm.execCommand('insertLineBefore'); return; }
    runEditor();
  }
  function clearErr() { if (Q.err) { try { Q.err.doc.removeLineClass(Q.err.h, 'background', 'db-errline'); } catch (_) {} Q.err = null; } }
  async function runSql(sql, src, offset, o = {}) {
    await ensureLoaded();
    const c = target();
    if (!c) {
      toast(__('Önce bir bağlantı seç'), __('Gezginin DB görünümünde bir bağlantıya ya da veritabanına tıkla.'));
      if (!IDE.ui.ex) { IDE.ui.ex = true; saveIdeUi(); }
      setExView('db'); showDrawer(true, true);
      return;
    }
    if (Q.running) { toast(__('Bir sorgu zaten çalışıyor'), __('Bitmesini bekle ya da iptal et.')); return; }
    if (!Q.drawer) await showDrawer(true, true);
    Q.running = true; Q.started = Date.now(); Q.connId = c.id; Q.db = st().db; Q.src = src; Q.offset = offset; Q.last = { sql, src, offset };
    Q.view = 'msg'; // the spinner shows there while the query runs
    clearErr();
    render();
    clearInterval(Q.tick); Q.tick = setInterval(() => { if (Q.running) render(); }, 500);
    const r = await inv('db:run', { tab: TAB, connId: c.id, db: st().db, sql, confirmed: !!o.confirmed, password: o.password, title: 'IDE' });
    Q.running = false; clearInterval(Q.tick);
    if (r.needPassword) {
      render();
      const pw = await dbApi.askPassword(c, r.loginFailed ? r.error : '');
      if (pw != null) return runSql(sql, src, offset, { ...o, password: pw });
      return;
    }
    if (r.blocked) {
      render();
      await dbApi.modal({ title: __('Salt okunur bağlantı'), icon: 'fa-lock', body: `<p>${__('<b>{name}</b> salt okunur olarak işaretli; şu ifadeler bu bağlantıda çalıştırılmaz:', { name: esc(c.name || c.host) })}</p><p class="db-codes">${r.blocked.map(b => `<code>${esc(b)}</code>`).join(' ')}</p>`, buttons: [['ok', __('Tamam'), 'primary']] });
      return;
    }
    if (r.confirm) {
      render();
      const ok = await dbApi.modal({ title: __('Bu sorgu veri silebilir'), icon: 'fa-triangle-exclamation', danger: true, body: `<p>${esc(__('Çalıştırmadan önce kontrol et:'))}</p><ul class="db-risks">${r.confirm.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="db-muted">${__('Bağlantı: <b>{name}</b>', { name: esc(c.name || c.host) })}${st().db ? ' · ' + esc(st().db) : ''}</p>`, buttons: [['cancel', __('Vazgeç')], ['ok', __('Yine de çalıştır'), 'danger']], focus: 'cancel' });
      if (ok && ok.value === 'ok') return runSql(sql, src, offset, { ...o, confirmed: true });
      return;
    }
    const old = Q.results.map(x => x.id);
    if (old.length) inv('db:release', old);
    if (r.error) {
      Q.results = []; Q.messages = [{ type: 'error', text: r.error }]; Q.ms = null; Q.view = 'msg';
      if (r.loginFailed) dbApi.setLive(c.id, { status: 'error', error: r.error });
    } else {
      Q.results = (r.results || []).map(x => ({ ...x, shown: x.rows.length, sel: null, widths: null, scroll: 0 }));
      Q.messages = r.messages || [];
      Q.ms = r.ms;
      const live = dbApi.live(c.id);
      if (!live || live.status !== 'ok') dbApi.setLive(c.id, { status: 'ok', error: '' });
      if (r.currentDb && r.currentDb !== st().db && st().connId === c.id) { st().db = r.currentDb; persist(); renderTarget(); }
      const hasErr = Q.messages.some(m => m.type === 'error');
      Q.view = Q.results.length && !hasErr && !r.cancelled ? 0 : 'msg';
      const em = Q.messages.find(m => m.type === 'error' && m.line);
      if (em && src.doc) {
        const l = Math.max(0, Math.min(src.doc.lastLine(), (offset || 0) + em.line - 1));
        try { Q.err = { doc: src.doc, h: src.doc.addLineClass(l, 'background', 'db-errline') }; } catch (_) {}
      }
    }
    render();
  }

  /* ---------------- wiring ---------------- */
  function init() {
    if (!window.dbApi || !byId('idbRes')) return;
    byId('tbDb').addEventListener('click', () => showDrawer(!Q.drawer));
    byId('tbSql').addEventListener('click', () => runEditor());
    // repaint after the IDE comes back into view (grid sizes and CodeMirror need a visible box)
    new MutationObserver(() => { if (!byId('ideView').hidden) refresh(); }).observe(byId('ideView'), { attributes: true, attributeFilter: ['hidden'] });
    // restore the drawer once the IDE layout (IDE.ui) is loaded
    const wait = setInterval(() => {
      if (!IDE.cm) return;
      clearInterval(wait);
      if (IDE.ui.db && IDE.ui.db.open) showDrawer(true, true);
    }, 200);
    try {
      SHORTCUTS.push({ group: 'IDE', keys: 'Ctrl+Shift+Enter', label: __("Seçili SQL'i (ya da .sql dosyasında imleçteki deyimi) seçili veritabanında çalıştır"), ide: true, run: runSmart });
    } catch (_) {}
  }
  window.ideDb = { showSide, showDrawer, run: runEditor };
  init();
})();
