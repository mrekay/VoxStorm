/* VoxStorm IDE: Deployment (like PhpStorm). A dock panel with the remote host browser of the project's
   deployment server (FTP / FTPS / SFTP), the server and mapping dialogs, "compare and sync", remote
   editing, and the Upload / Download / Compare items of the file tree menu. Transfers run in main
   (ftp.js); automatic upload on save is triggered from saveFile (app.js -> ideFtp.saved).
   Uses globals from app.js: $, esc, toast, IDE, proj, projRoot, relOf, fileIcon, MODES, extOf, baseName,
   openFile, copyText, cleanErr, SEP, normPath, fmtSize. Dialogs and menus: window.dbApi (db.js). */
/* global api, CodeMirror, dbApi */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const inv = async (ch, ...a) => { try { const r = await api.invoke(ch, ...a); return r; } catch (e) { return { error: cleanErr(e) }; } };
  const err = r => r && typeof r === 'object' && !Array.isArray(r) && r.error;
  const fmtT = ms => (ms ? new Date(ms).toLocaleString(I18N.locale(), { dateStyle: 'short', timeStyle: 'short' }) : '');
  const rjoin = (a, b) => ('/' + [a, b].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  const rparent = p => { const i = p.replace(/\/$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  const rbase = p => p.replace(/\/$/, '').split('/').pop() || '/';
  const TYPE_LABEL = { ftp: 'FTP', ftps: 'FTPS', 'ftps-implicit': 'FTPS (implicit)', sftp: 'SFTP' };

  const X = {
    built: false, servers: [], canEncrypt: true, project: null, root: '', dep: null,
    kids: {}, open: new Set(), cur: '', connected: new Set(), status: '', statusT: null, busy: false,
  };
  const srv = id => X.servers.find(s => s.id === id);
  const curSrv = () => (X.dep && srv(X.dep.server)) || null;

  async function loadServers() {
    const r = await inv('ftp:list');
    if (err(r)) { toast(__('FTP sunucuları okunamadı'), r.error); return; }
    X.servers = r.servers; X.canEncrypt = r.canEncrypt;
  }
  async function loadDeploy() {
    const p = proj(IDE.project);
    X.project = IDE.project; X.root = p ? p.path.replace(/[\\/]+$/, '') : '';
    X.dep = X.root ? await inv('ftp:getDeploy', X.root) : null;
    if (err(X.dep)) X.dep = null;
    X.kids = {}; X.open = new Set(); X.cur = '';
    render();
    const s = curSrv(); if (s && visible()) loadDir(s.root || '/');
  }
  const visible = () => { const el = byId('iftpSide'); return !!(el && el.offsetWidth && el.offsetHeight); };
  async function saveDeploy(patch) {
    if (!X.root) return;
    const d = Object.assign({}, X.dep || {}, patch);
    const r = await inv('ftp:setDeploy', X.root, d);
    if (err(r)) { toast(__('Kaydedilemedi'), r.error); return; }
    X.dep = Object.assign(r, { defaults: X.dep && X.dep.defaults });
  }

  /* ---------------- connecting ---------------- */
  // runs fn; when the server wants a password, asks for it once and tries again
  async function withConn(s, fn) {
    let r = await fn();
    if (err(r) && r.needPassword) {
      // ui.js's dialog: it never closes a dbApi modal that is open (the sync window)
      const pw = await uiPrompt({
        title: __('Parola gerekli'), icon: 'fa-key', password: true, maxLength: 512,
        message: `${s.name || s.host} (${TYPE_LABEL[s.type]}${s.user ? ' · ' + s.user : ''})`,
        detail: r.error + '\n' + __('Parola yalnızca bu oturum boyunca bellekte tutulur.'),
        placeholder: __('Parola'), ok: __('Bağlan'),
      });
      if (pw == null) return r;
      const c = await inv('ftp:connect', s.id, pw);
      if (err(c)) return c;
      r = await fn();
    }
    return r;
  }
  async function loadDir(dir, force) {
    const s = curSrv(); if (!s) return;
    if (X.kids[dir] && X.kids[dir].items && !force) { render(); return; }
    X.kids[dir] = { loading: true }; render();
    const r = await withConn(s, () => inv('ftp:ls', s.id, dir));
    X.kids[dir] = err(r) ? { error: r.error } : { items: r };
    if (!err(r)) X.connected.add(s.id);
    render();
  }

  /* ---------------- panel ---------------- */
  function build() {
    const el = byId('iftpSide');
    el.innerHTML = `
      <div class="idb-bar iftp-bar">
        <select id="iftpSrv" class="iftp-sel" aria-label="${esc(__('Deployment sunucusu'))}"></select>
        <button class="db-ib" data-ft="newSrv" title="${esc(__('Yeni sunucu'))}" aria-label="${esc(__('Yeni sunucu'))}"><i class="fa-solid fa-plus"></i></button>
        <button class="db-ib" data-ft="editSrv" title="${esc(__('Sunucuyu düzenle'))}" aria-label="${esc(__('Sunucuyu düzenle'))}"><i class="fa-solid fa-pen"></i></button>
        <button class="db-ib" data-ft="deploy" title="${esc(__('Deployment ayarları: eşlemeler, hariç tutulanlar, otomatik yükleme'))}" aria-label="${esc(__('Deployment ayarları'))}"><i class="fa-solid fa-sliders"></i></button>
        <button class="db-ib" data-ft="sync" title="${esc(__('Sunucuyla karşılaştır ve senkronize et'))}" aria-label="${esc(__('Senkronize et'))}"><i class="fa-solid fa-right-left"></i></button>
        <button class="db-ib" data-ft="refresh" title="${esc(__('Yenile'))}" aria-label="${esc(__('Yenile'))}"><i class="fa-solid fa-arrows-rotate"></i></button>
        <button class="db-ib" data-ft="disconnect" title="${esc(__('Bağlantıyı kes'))}" aria-label="${esc(__('Bağlantıyı kes'))}"><i class="fa-solid fa-plug-circle-xmark"></i></button>
      </div>
      <div class="iftp-auto" id="iftpAuto"></div>
      <div class="db-list iftp-tree" id="iftpTree" tabindex="0" role="tree" aria-label="${esc(__('Uzak sunucu dosyaları'))}"></div>
      <div class="idb-hint iftp-st" id="iftpSt" aria-live="polite"></div>`;
    el.addEventListener('click', onClick);
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('contextmenu', onMenu);
    el.addEventListener('change', onChange);
    byId('iftpTree').addEventListener('keydown', onKey);
  }
  function render() {
    if (!X.built) return;
    const sel = byId('iftpSrv'), s = curSrv();
    sel.innerHTML = `<option value="">${esc(X.servers.length ? __('— sunucu seç —') : __('Sunucu yok: + ile ekle'))}</option>`
      + X.servers.map(x => `<option value="${esc(x.id)}"${s && s.id === x.id ? ' selected' : ''}>${esc((x.name || x.host) + ' · ' + TYPE_LABEL[x.type])}</option>`).join('');
    sel.disabled = !X.root;
    const auto = X.dep ? X.dep.auto : 'off';
    byId('iftpAuto').innerHTML = !X.root ? '' : !s
      ? `<span class="db-muted">${esc(__('Bu proje için bir sunucu seç; eşlemeleri ve otomatik yüklemeyi ayarlardan düzenle.'))}</span>`
      : `<span class="iftp-addr" title="${esc(s.root)}"><i class="fa-solid fa-folder-tree"></i> ${esc(s.root)}</span>
         <label class="iftp-al" title="${esc(__('Otomatik yükleme'))}"><i class="fa-solid fa-cloud-arrow-up"></i><select id="iftpAutoSel" aria-label="${esc(__('Otomatik yükleme'))}">
           <option value="off"${auto === 'off' ? ' selected' : ''}>${esc(__('Otomatik yükleme kapalı'))}</option>
           <option value="save"${auto === 'save' ? ' selected' : ''}>${esc(__('Kaydedince yükle'))}</option>
           <option value="always"${auto === 'always' ? ' selected' : ''}>${esc(__('Her değişiklikte yükle (Claude’un düzenlemeleri dahil)'))}</option>
         </select></label>`;
    byId('iftpSide').querySelectorAll('[data-ft=editSrv],[data-ft=sync],[data-ft=refresh],[data-ft=disconnect]').forEach(b => { b.disabled = !s; });
    byId('iftpSide').querySelector('[data-ft=deploy]').disabled = !X.root;
    renderTree();
    renderStatus();
  }
  function renderTree() {
    const el = byId('iftpTree'), s = curSrv();
    if (!el) return;
    if (!X.root) { el.innerHTML = `<div class="db-node empty"><span class="db-nm">${esc(__('IDE’de açık proje yok'))}</span></div>`; return; }
    if (!s) { el.innerHTML = ''; return; }
    const top = el.scrollTop;
    const rows = [];
    const rootDir = s.root || '/';
    const walk = (dir, depth) => {
      const k = X.kids[dir];
      if (!k || k.loading) { rows.push(`<div class="db-node empty" style="padding-left:${12 + depth * 14}px"><i class="fa-solid fa-spinner fa-spin db-ni"></i><span class="db-nm">${esc(__('Yükleniyor…'))}</span></div>`); return; }
      if (k.error) { rows.push(`<div class="db-node err" style="padding-left:${12 + depth * 14}px"><i class="fa-solid fa-circle-exclamation db-ni"></i><span class="db-nm">${esc(k.error)}</span></div>`); return; }
      if (!k.items.length) { rows.push(`<div class="db-node empty" style="padding-left:${12 + depth * 14}px"><span class="db-nm">${esc(__('(boş klasör)'))}</span></div>`); return; }
      for (const f of k.items) {
        const p = rjoin(dir, f.name), open = f.dir && X.open.has(p);
        rows.push(`<div class="db-node${X.cur === p ? ' cur' : ''}" role="treeitem" data-rp="${esc(p)}"${f.dir ? ` data-dir="1" aria-expanded="${open}"` : ''} style="padding-left:${8 + depth * 14}px" title="${esc(p + (f.dir ? '' : ' · ' + fmtSize(f.size || 0)) + (f.mtime ? ' · ' + fmtT(f.mtime) : ''))}">
          <i class="db-car fa-solid ${f.dir ? (open ? 'fa-chevron-down' : 'fa-chevron-right') : ''}"></i>${f.dir ? `<i class="db-ni fa-solid ${open ? 'fa-folder-open' : 'fa-folder'} iftp-dir"></i>` : fileIcon(f.name).replace('class="', 'class="db-ni ')}<span class="db-nm">${esc(f.name)}</span>${f.dir ? '' : `<span class="db-cnt">${esc(fmtSize(f.size || 0))}</span>`}</div>`);
        if (open) walk(p, depth + 1);
      }
    };
    rows.push(`<div class="db-node conn${X.cur === rootDir ? ' cur' : ''}" data-rp="${esc(rootDir)}" data-dir="1" data-root="1" style="--dbc:var(--accent)"><i class="db-ni fa-solid fa-server"></i><span class="db-nm">${esc(s.name || s.host)}</span><span class="db-meta">${esc(rootDir)}</span><span class="db-st${X.connected.has(s.id) ? ' ok' : ''}"></span></div>`);
    walk(rootDir, 0);
    el.innerHTML = rows.join('');
    el.scrollTop = top;
  }
  function status(text, kind) {
    X.status = text ? { text, kind: kind || '' } : null;
    clearTimeout(X.statusT);
    if (text && kind !== 'busy') X.statusT = setTimeout(() => { X.status = null; renderStatus(); }, 8000);
    renderStatus();
  }
  function renderStatus() {
    const el = byId('iftpSt'); if (!el) return;
    const st = X.status;
    el.className = 'idb-hint iftp-st' + (st && st.kind ? ' ' + st.kind : '');
    el.innerHTML = st ? `${st.kind === 'busy' ? '<i class="fa-solid fa-spinner fa-spin"></i> ' : st.kind === 'err' ? '<i class="fa-solid fa-circle-exclamation"></i> ' : '<i class="fa-solid fa-check"></i> '}${esc(st.text)}`
      : esc(__('Çift tık: uzak dosyayı düzenle · Sağ tık: indir, karşılaştır, sil…'));
  }

  /* ---------------- panel events ---------------- */
  async function onClick(e) {
    const b = e.target.closest('[data-ft]');
    if (b) {
      const a = b.dataset.ft, s = curSrv();
      if (a === 'newSrv') { const id = await editServer(null); if (id && X.root && !curSrv()) { await saveDeploy({ server: id }); loadDeploy(); } }
      else if (a === 'editSrv' && s) { await editServer(s.id); }
      else if (a === 'deploy') deploySettings();
      else if (a === 'sync') syncDialog('');
      else if (a === 'refresh' && s) { X.kids = {}; loadDir(s.root || '/', true); for (const p of X.open) loadDir(p, true); }
      else if (a === 'disconnect' && s) { await inv('ftp:disconnect', s.id); X.connected.delete(s.id); X.kids = {}; X.open = new Set(); render(); }
      return;
    }
    const n = e.target.closest('.db-node[data-rp]');
    if (!n || e.detail !== 1) return;
    X.cur = n.dataset.rp;
    if (n.dataset.dir && !n.dataset.root) toggle(n.dataset.rp); else renderTree();
  }
  function toggle(p) {
    if (X.open.has(p)) X.open.delete(p); else { X.open.add(p); loadDir(p); }
    renderTree();
  }
  function onDbl(e) {
    const n = e.target.closest('.db-node[data-rp]'); if (!n || n.dataset.dir) return;
    remoteEdit(n.dataset.rp);
  }
  async function onChange(e) {
    if (e.target.id === 'iftpSrv') { await saveDeploy({ server: e.target.value }); loadDeploy(); }
    else if (e.target.id === 'iftpAutoSel') { await saveDeploy({ auto: e.target.value }); status(e.target.value === 'off' ? __('Otomatik yükleme kapatıldı') : __('Otomatik yükleme açık')); }
  }
  function onKey(e) {
    const all = [...byId('iftpTree').querySelectorAll('.db-node[data-rp]')];
    let i = all.findIndex(n => n.dataset.rp === X.cur);
    const n = all[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); if (all[i]) { X.cur = all[i].dataset.rp; renderTree(); } }
    else if (!n) return;
    else if (e.key === 'Enter') { e.preventDefault(); if (n.dataset.dir) toggle(n.dataset.rp); else remoteEdit(n.dataset.rp); }
    else if (e.key === 'ArrowRight' && n.dataset.dir && !X.open.has(n.dataset.rp)) toggle(n.dataset.rp);
    else if (e.key === 'ArrowLeft' && n.dataset.dir && X.open.has(n.dataset.rp)) toggle(n.dataset.rp);
    else if (e.key === 'Delete' && !n.dataset.root) removeRemote(n.dataset.rp, !!n.dataset.dir);
    else if (e.key === 'F2' && !n.dataset.root) renameRemote(n.dataset.rp);
  }
  async function onMenu(e) {
    const n = e.target.closest('.db-node[data-rp]'); const s = curSrv();
    if (!n || !s) return;
    e.preventDefault();
    const p = n.dataset.rp, isDir = !!n.dataset.dir, isRoot = !!n.dataset.root;
    X.cur = p; renderTree();
    const local = await inv('ftp:resolveRemote', X.root, s.id, p);
    const mapped = typeof local === 'string' && local;
    const items = isDir ? [
      ['newfile', __('Yeni dosya'), 'fa-file-circle-plus'],
      ['newdir', __('Yeni klasör'), 'fa-folder-plus'],
      ['refresh', __('Yenile'), 'fa-arrows-rotate'],
      '-',
      ['download', __('Projeye indir'), 'fa-cloud-arrow-down', !mapped],
      ['sync', __('Bu klasörü senkronize et'), 'fa-right-left', !mapped],
      '-',
      ['rename', __('Yeniden adlandır'), 'fa-i-cursor', isRoot, 'F2'],
      ['delete', __('Sil'), 'fa-trash-can', isRoot, 'Delete'],
      '-',
      ['copy', __('Yolu kopyala'), 'fa-copy'],
    ] : [
      ['edit', __('Uzak dosyayı düzenle'), 'fa-pen-to-square'],
      ['openLocal', __('Projedeki dosyayı aç'), 'fa-file-code', !mapped],
      ['download', __('Projeye indir'), 'fa-cloud-arrow-down', !mapped],
      ['compare', __('Projedeki dosyayla karşılaştır'), 'fa-code-compare', !mapped],
      '-',
      ['rename', __('Yeniden adlandır'), 'fa-i-cursor', false, 'F2'],
      ['delete', __('Sil'), 'fa-trash-can', false, 'Delete'],
      '-',
      ['copy', __('Yolu kopyala'), 'fa-copy'],
      ['web', __('Tarayıcıda aç'), 'fa-globe', !s.webUrl || !mapped],
    ];
    const a = await dbApi.menu(e.clientX, e.clientY, items);
    if (!a) return;
    if (a === 'edit') remoteEdit(p);
    else if (a === 'openLocal') openFile(local);
    else if (a === 'download') { const r = await transfer('ftp:download', [local], s.id); if (r && !isDir && r.done) openFile(local); }
    else if (a === 'compare') compareFile(local);
    else if (a === 'sync') syncDialog(relOf(local).replace(/\\/g, '/'));
    else if (a === 'refresh') loadDir(p, true);
    else if (a === 'newfile' || a === 'newdir') newRemote(p, a === 'newdir');
    else if (a === 'rename') renameRemote(p);
    else if (a === 'delete') removeRemote(p, isDir);
    else if (a === 'copy') copyText(p, __('Yol kopyalandı'));
    else if (a === 'web') { const t = await inv('ftp:resolve', X.root, local, s.id); if (t && t.url) api.invoke('shell:openLink', t.url); }
  }

  /* ---------------- remote file operations ---------------- */
  async function newRemote(dir, isDir) {
    const s = curSrv();
    const name = await uiPrompt({ title: isDir ? __('Yeni klasör') : __('Yeni dosya'), message: dir, placeholder: isDir ? __('klasör adı') : __('dosya adı') });
    if (!name || !name.trim()) return;
    const p = rjoin(dir, name.trim());
    const r = await withConn(s, () => inv('ftp:op', s.id, isDir ? 'mkdir' : 'newfile', p));
    if (err(r)) { toast(__('Oluşturulamadı'), r.error); return; }
    X.open.add(dir); await loadDir(dir, true);
    if (!isDir) remoteEdit(p);
  }
  async function renameRemote(p) {
    const s = curSrv();
    const name = await uiPrompt({ title: __('Yeniden adlandır'), message: p, input: rbase(p) });
    if (!name || !name.trim() || name.trim() === rbase(p)) return;
    const to = name.includes('/') ? name.trim() : rjoin(rparent(p), name.trim());
    const r = await withConn(s, () => inv('ftp:op', s.id, 'rename', p, to));
    if (err(r)) { toast(__('Yeniden adlandırılamadı'), r.error); return; }
    loadDir(rparent(p), true);
  }
  async function removeRemote(p, isDir) {
    const s = curSrv();
    if (!(await uiConfirm({ title: __('Sunucudan sil'), message: isDir ? __('“{name}” klasörü içindekilerle birlikte sunucudan silinecek.', { name: p }) : __('“{name}” sunucudan silinecek.', { name: p }), ok: __('Sil'), danger: true }))) return;
    status(__('Siliniyor: {path}', { path: p }), 'busy');
    const r = await withConn(s, () => inv('ftp:op', s.id, 'remove', p, isDir));
    if (err(r)) { status(r.error, 'err'); return; }
    status(__('Silindi: {path}', { path: p }));
    X.open.delete(p); loadDir(rparent(p), true);
  }
  // upload / download project files (or folders) through the mapping
  async function transfer(ch, files, sid) {
    const s = srv(sid) || curSrv();
    if (!s) { toast(__('Deployment sunucusu yok'), __('Deployment panelinden bu proje için bir sunucu seç.')); return null; }
    const up = ch === 'ftp:upload';
    status(up ? __('Yükleniyor…') : __('İndiriliyor…'), 'busy');
    const r = await withConn(s, () => inv(ch, X.root, files, s.id));
    if (err(r)) { status(r.error, 'err'); toast(up ? __('Yüklenemedi') : __('İndirilemedi'), r.error); return null; }
    if (r.errors.length) { status(r.errors[0], 'err'); toast(__('{n} dosyada hata', { n: r.errors.length }), r.errors.slice(0, 5).join('\n')); }
    else status(up ? __('{n} dosya yüklendi → {name}', { n: r.done, name: s.name || s.host }) : __('{n} dosya indirildi ← {name}', { n: r.done, name: s.name || s.host }));
    if (up) { const s0 = curSrv(); if (s0 && X.kids[s0.root || '/']) loadDir(s0.root || '/', true); for (const p of X.open) if (X.kids[p]) loadDir(p, true); }
    return r;
  }

  /* ---------------- remote editor ---------------- */
  async function remoteEdit(p) {
    const s = curSrv(); if (!s) return;
    status(__('Açılıyor: {path}', { path: p }), 'busy');
    const r = await withConn(s, () => inv('ftp:readText', s.id, p));
    if (err(r)) { status(r.error, 'err'); toast(__('Açılamadı'), r.error); return; }
    status('');
    let cm = null, saved = r.text, dirty = false;
    const res = await dbApi.modal({
      title: `${s.name || s.host}: ${p}`, icon: 'fa-pen-to-square', wide: true,
      body: `<div class="iftp-ed" id="iftpEd"></div><p class="db-muted iftp-edst" id="iftpEdSt">${esc(__('Ctrl+S: sunucuya kaydet'))}</p>`,
      buttons: [['cancel', __('Kapat')], ['local', __('Projeye indir')], ['save', __('Sunucuya kaydet'), 'primary']],
      onOpen: form => {
        form.classList.add('iftp-edform');
        cm = CodeMirror(form.querySelector('#iftpEd'), {
          value: r.text, mode: MODES[extOf(p)] || 'text/plain', theme: 'claudelot', lineNumbers: true, indentUnit: 2, tabSize: 2, styleActiveLine: true, matchBrackets: true, autoCloseBrackets: true, keyMap: 'sublime', lineWrapping: false,
          extraKeys: { 'Ctrl-S': () => form.querySelector('[data-mb=save]').click(), 'Cmd-S': () => form.querySelector('[data-mb=save]').click() },
        });
        cm.on('change', () => { dirty = cm.getValue() !== saved; form.querySelector('#iftpEdSt').textContent = dirty ? __('Kaydedilmemiş değişiklik var · Ctrl+S: sunucuya kaydet') : __('Ctrl+S: sunucuya kaydet'); });
        form.parentElement.onmousedown = null; // a click outside must not throw the edits away
        cm.getWrapperElement().addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });
        setTimeout(() => { cm.refresh(); cm.focus(); }, 30);
      },
      onAction: async (act, _f, form) => {
        if (act === 'save') {
          const text = cm.getValue();
          const w = await withConn(s, () => inv('ftp:writeText', s.id, p, text));
          if (err(w)) { toast(__('Kaydedilemedi'), w.error); return true; }
          saved = text; dirty = false;
          form.querySelector('#iftpEdSt').textContent = __('Sunucuya kaydedildi · {time}', { time: new Date().toLocaleTimeString(I18N.locale()) });
          loadDir(rparent(p), true);
          return true;
        }
        if (act === 'local') {
          const local = await inv('ftp:resolveRemote', X.root, s.id, p);
          if (typeof local !== 'string' || !local) { toast(__('Eşleme yok'), __('Bu uzak klasör projede bir klasöre eşlenmemiş; Deployment ayarlarından eşleme ekle.')); return true; }
          if (dirty) { const w = await withConn(s, () => inv('ftp:writeText', s.id, p, cm.getValue())); if (err(w)) { toast(__('Kaydedilemedi'), w.error); return true; } }
          const d = await withConn(s, () => inv('ftp:downloadTo', X.root, s.id, p, local));
          if (err(d)) { toast(__('İndirilemedi'), d.error); return true; }
          openFile(local);
          return false;
        }
        if (act === 'cancel' && dirty && !(await uiConfirm({ title: __('Kaydedilmemiş değişiklik'), message: __('Değişiklikler sunucuya kaydedilmedi. Yine de kapatılsın mı?'), ok: __('Kapat'), danger: true }))) return true;
        return false;
      },
    });
    return res;
  }

  /* ---------------- compare (a project file with its deployed copy) ---------------- */
  // a line diff (LCS), enough for source files
  function lineDiff(a, b) {
    const A = a.split('\n'), B = b.split('\n');
    let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    const a2 = A.slice(s, ea), b2 = B.slice(s, eb), n = a2.length, m = b2.length;
    const out = [];
    for (let i = 0; i < s; i++) out.push([' ', A[i], i + 1, i + 1]);
    if (n * m > 4e6) { a2.forEach((l, i) => out.push(['-', l, s + i + 1, null])); b2.forEach((l, j) => out.push(['+', l, null, s + j + 1])); }
    else {
      const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && a2[i] === b2[j]) { out.push([' ', a2[i], s + i + 1, s + j + 1]); i++; j++; }
        else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { out.push(['-', a2[i], s + i + 1, null]); i++; } // removed lines first, like a unified diff
        else { out.push(['+', b2[j], null, s + j + 1]); j++; }
      }
    }
    for (let i = ea; i < A.length; i++) out.push([' ', A[i], i + 1, i - ea + eb + 1]);
    return out;
  }
  async function compareFile(fp) {
    const s = curSrv(); if (!s) return;
    status(__('Karşılaştırılıyor…'), 'busy');
    const [loc, rem] = await Promise.all([inv('fs:read', fp), withConn(s, () => inv('ftp:remoteText', X.root, fp, s.id))]);
    status('');
    if (err(loc)) { toast(__('Açılamadı'), loc.error); return; }
    if (err(rem)) { toast(__('Açılamadı'), rem.error); return; }
    const lt = loc.text.replace(/\r\n/g, '\n'), rt = rem.text == null ? null : rem.text.replace(/\r\n/g, '\n');
    let body;
    if (rt == null) body = `<p class="db-note warn"><i class="fa-solid fa-triangle-exclamation"></i>${esc(__('Dosya sunucuda yok: {path}', { path: rem.remote }))}</p>`;
    else if (rt === lt) body = `<p class="db-note"><i class="fa-solid fa-check"></i>${esc(__('Dosyalar aynı.'))}</p>`;
    else {
      const d = lineDiff(rt, lt);
      // only the changed parts, with 3 lines around them
      const keep = new Set();
      d.forEach((x, i) => { if (x[0] !== ' ') for (let k = i - 3; k <= i + 3; k++) keep.add(k); });
      let html = '', last = -1;
      d.forEach((x, i) => {
        if (!keep.has(i)) return;
        if (last >= 0 && i > last + 1) html += '<div class="iftp-dl gap">⋯</div>';
        html += `<div class="iftp-dl ${x[0] === '+' ? 'add' : x[0] === '-' ? 'del' : ''}"><span class="n">${x[2] || ''}</span><span class="n">${x[3] || ''}</span><span class="s">${x[0]}</span><span class="t">${esc(x[1]) || ' '}</span></div>`;
        last = i;
      });
      const add = d.filter(x => x[0] === '+').length, del = d.filter(x => x[0] === '-').length;
      body = `<p class="db-muted">${esc(__('Sol numara: sunucu · sağ numara: proje'))} · <b class="iftp-add">+${add}</b> <b class="iftp-del">−${del}</b></p><div class="iftp-diff">${html}</div>`;
    }
    const r = await dbApi.modal({
      title: __('Karşılaştır: {name}', { name: baseName(fp) }), icon: 'fa-code-compare', wide: true,
      body: `<p class="db-muted iftp-paths"><span><i class="fa-solid fa-server"></i> ${esc(rem.remote)}</span><span><i class="fa-regular fa-file"></i> ${esc(relOf(fp))}</span></p>${body}`,
      buttons: [['cancel', __('Kapat')], ...(rt !== lt ? [['down', __('Sunucudakini al')], ['up', __('Projedekini yükle'), 'primary']] : [])],
      onOpen: f => f.classList.add('iftp-cmpform'),
    });
    if (r && r.value === 'up') transfer('ftp:upload', [fp]);
    else if (r && r.value === 'down') { const t = await transfer('ftp:download', [fp]); if (t && t.done && window.reloadFromDisk) reloadFromDisk(fp, true); }
  }

  /* ---------------- sync dialog ---------------- */
  const STATE = {
    'local-only': [__('Yalnızca projede'), 'fa-circle-plus', 'up'],
    'remote-only': [__('Yalnızca sunucuda'), 'fa-cloud', 'down'],
    'local-changed': [__('Projede değişmiş'), 'fa-arrow-up', 'up'],
    'remote-changed': [__('Sunucuda değişmiş'), 'fa-arrow-down', 'down'],
    conflict: [__('İki tarafta da değişmiş'), 'fa-triangle-exclamation', 'skip'],
    'local-deleted': [__('Projeden silinmiş'), 'fa-trash-can', 'skip'],
    'remote-deleted': [__('Sunucudan silinmiş'), 'fa-trash-can', 'skip'],
    same: [__('Aynı'), 'fa-equals', 'skip'],
  };
  const ACTS = { up: [__('Yükle →'), 'fa-arrow-right'], down: [__('← İndir'), 'fa-arrow-left'], skip: [__('Atla'), 'fa-minus'], delRemote: [__('Sunucudan sil'), 'fa-trash-can'], delLocal: [__('Projeden sil'), 'fa-trash-can'] };
  const actsFor = st => ({ 'local-only': ['up', 'skip', 'delLocal'], 'remote-only': ['down', 'skip', 'delRemote'], 'local-deleted': ['delRemote', 'down', 'skip'], 'remote-deleted': ['delLocal', 'up', 'skip'], same: ['skip', 'up', 'down'] }[st] || ['up', 'down', 'skip']);
  async function syncDialog(sub) {
    const s = curSrv();
    if (!s) { toast(__('Deployment sunucusu yok'), __('Deployment panelinden bu proje için bir sunucu seç.')); return; }
    const pre = await withConn(s, () => inv('ftp:ls', s.id, s.root || '/'));
    if (err(pre)) { toast(__('Bağlanılamadı'), pre.error); return; }
    const job = 'j' + Math.random().toString(36).slice(2, 9);
    let items = null, showSame = false, running = false;
    const off = api.on('ftp:progress', p => {
      if (p.job !== job) return;
      const el = document.getElementById('iftpSyncSt');
      if (el && !p.end) el.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${esc(__('{done} / {total} · {path}', { done: p.done, total: p.total, path: p.rel }))}`;
    });
    const rowHtml = (it, i) => {
      const st = STATE[it.state] || [it.state, 'fa-question', 'skip'];
      return `<tr class="st-${it.state}"${it.state === 'same' && !showSame ? ' hidden' : ''}><td class="iftp-si" title="${esc(st[0])}"><i class="fa-solid ${st[1]}"></i></td><td class="iftp-sp" title="${esc(it.rel)}">${esc(it.rel)}<small>${esc(st[0])}</small></td>
        <td class="iftp-sm">${it.lsize != null ? esc(fmtSize(it.lsize)) + '<small>' + esc(fmtT(it.lmtime)) + '</small>' : '—'}</td>
        <td><select data-si="${i}" aria-label="${esc(__('İşlem'))}">${actsFor(it.state).map(a => `<option value="${a}"${it.act === a ? ' selected' : ''}>${esc(ACTS[a][0])}</option>`).join('')}</select></td>
        <td class="iftp-sm">${it.rsize != null ? esc(fmtSize(it.rsize)) + '<small>' + esc(fmtT(it.rmtime)) + '</small>' : '—'}</td></tr>`;
    };
    const tableHtml = () => {
      if (!items) return `<div class="iftp-sload"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(__('Proje ve sunucu karşılaştırılıyor…'))}</div>`;
      const diff = items.filter(x => x.state !== 'same');
      if (!diff.length && !showSame) return `<p class="db-note"><i class="fa-solid fa-check"></i>${esc(__('Her şey senkron: projeyle sunucu aynı.'))}</p>`;
      return `<table class="iftp-sync"><thead><tr><th></th><th>${esc(__('Dosya'))}</th><th>${esc(__('Proje'))}</th><th>${esc(__('İşlem'))}</th><th>${esc(__('Sunucu'))}</th></tr></thead><tbody>${items.map(rowHtml).join('')}</tbody></table>`;
    };
    const summary = () => {
      if (!items) return '';
      const n = a => items.filter(x => x.act === a).length;
      return __('{up} yüklenecek · {down} indirilecek · {del} silinecek · {same} aynı', { up: n('up'), down: n('down'), del: n('delRemote') + n('delLocal'), same: items.filter(x => x.state === 'same').length });
    };
    const res = dbApi.modal({
      title: __('Senkronize et: {name}', { name: s.name || s.host }), icon: 'fa-right-left', wide: true,
      body: `<p class="db-muted iftp-paths"><span><i class="fa-regular fa-folder"></i> ${esc(sub || __('(tüm eşlemeler)'))}</span><span><i class="fa-solid fa-server"></i> ${esc(s.root)}</span></p>
        <div class="iftp-stools"><button type="button" class="btn" data-mb="allUp"><i class="fa-solid fa-arrow-right"></i> ${esc(__('Değişenlerin hepsini yükle'))}</button><button type="button" class="btn" data-mb="allDown"><i class="fa-solid fa-arrow-left"></i> ${esc(__('Değişenlerin hepsini indir'))}</button><label class="db-ck"><input type="checkbox" id="iftpSame"><span>${esc(__('Aynı olanları da göster'))}</span></label></div>
        <div class="iftp-sbox" id="iftpSBox">${tableHtml()}</div><p class="db-muted" id="iftpSyncSt"></p>`,
      buttons: [['cancel', __('Kapat')], ['recompare', __('Yeniden karşılaştır')], ['run', __('Senkronize et'), 'primary']],
      onOpen: form => {
        form.classList.add('iftp-syncform');
        form.addEventListener('change', e => {
          if (e.target.id === 'iftpSame') { showSame = e.target.checked; form.querySelector('#iftpSBox').innerHTML = tableHtml(); }
          else if (e.target.dataset.si != null) { items[+e.target.dataset.si].act = e.target.value; form.querySelector('#iftpSyncSt').textContent = summary(); }
        });
        compareNow(form);
      },
      onAction: async (act, _f, form) => {
        if (running) return true;
        if (act === 'recompare') { items = null; form.querySelector('#iftpSBox').innerHTML = tableHtml(); compareNow(form); return true; }
        if (act === 'allUp' || act === 'allDown') {
          if (!items) return true;
          for (const it of items) if (it.state !== 'same') { const want = act === 'allUp' ? 'up' : 'down'; if (actsFor(it.state).includes(want)) it.act = want; }
          form.querySelector('#iftpSBox').innerHTML = tableHtml(); form.querySelector('#iftpSyncSt').textContent = summary();
          return true;
        }
        if (act === 'run') {
          if (!items) return true;
          const list = items.filter(x => x.act && x.act !== 'skip').map(x => ({ rel: x.rel, act: x.act, remote: x.remote, rsize: x.rsize, rmtime: x.rmtime }));
          // "same" files never synced through VoxStorm: remember them, so the next compare knows both sides
          const mark = items.filter(x => x.state === 'same').map(x => ({ rel: x.rel, act: 'mark', rsize: x.rsize, rmtime: x.rmtime }));
          if (!list.length) { await inv('ftp:sync', X.root, s.id, mark, job + 'm'); toast(__('Yapılacak bir şey yok')); return true; }
          const dels = list.filter(x => x.act === 'delRemote' || x.act === 'delLocal').length;
          if (dels && !(await uiConfirm({ title: __('Silme onayı'), message: __('{n} dosya silinecek (projeden silinenler Geri Dönüşüm Kutusu’na gider).', { n: dels }), ok: __('Devam et'), danger: true }))) return true;
          running = true;
          form.querySelectorAll('.db-df button, select, .iftp-stools button').forEach(b => { if (b.dataset.mb !== 'cancel') b.disabled = true; });
          const r = await inv('ftp:sync', X.root, s.id, list.concat(mark), job);
          running = false;
          if (err(r)) { toast(__('Senkronize edilemedi'), r.error); return true; }
          const failed = r.errors.length;
          toast(failed ? __('Senkron tamamlandı, {n} hata', { n: failed }) : __('Senkron tamamlandı'), failed ? r.errors.slice(0, 6).join('\n') : __('{n} işlem', { n: r.done - mark.length }));
          status(__('Senkron tamamlandı'));
          IDE.dirCache = {}; if (typeof window.renderTree === 'function') window.renderTree(); // the project's file tree (app.js)
          for (const p of X.open) loadDir(p, true);
          return false;
        }
        if (act === 'cancel') { await inv('ftp:cancel', job); return false; }
        return false;
      },
    });
    async function compareNow(form) {
      const r = await withConn(s, () => inv('ftp:compare', X.root, s.id, sub));
      if (!form.isConnected) return;
      if (err(r)) { form.querySelector('#iftpSBox').innerHTML = `<p class="db-errbox">${esc(r.error)}</p>`; return; }
      items = r.items.map(x => Object.assign(x, { act: (STATE[x.state] || [])[2] || 'skip' }));
      form.querySelector('#iftpSBox').innerHTML = tableHtml();
      form.querySelector('#iftpSyncSt').textContent = summary() + (r.cut ? ' · ' + __('(liste kısaltıldı: çok fazla dosya)') : '');
    }
    await res; off();
  }

  /* ---------------- server dialog ---------------- */
  async function editServer(id) {
    await loadServers();
    const c = id ? srv(id) : null;
    const v = c ? { ...c } : { type: 'ftp', host: '', port: '', user: '', auth: 'password', root: '/', timeMode: 'keep' };
    const chk = x => (x ? ' checked' : '');
    const sel = (a, b) => (a === b ? ' selected' : '');
    const body = `
      <div class="db-grid2">
        <div class="db-f full"><span>${esc(__('Tür'))}</span><div class="db-typesel">${Object.entries(TYPE_LABEL).map(([k, l]) => `<label><input type="radio" name="type" value="${k}"${chk(v.type === k)}><span>${esc(l)}</span></label>`).join('')}</div></div>
        <label class="db-f wide"><span>${esc(__('Ad'))}</span><input name="name" value="${esc(v.name || '')}" placeholder="${esc(__('Örn. Canlı site'))}" maxlength="80"></label>
        <label class="db-f"><span>${esc(__('Grup'))}</span><input name="group" value="${esc(v.group || '')}" placeholder="${esc(__('İsteğe bağlı'))}" maxlength="60"></label>
        <label class="db-f wide"><span>${esc(__('Sunucu'))}</span><input name="host" value="${esc(v.host || '')}" placeholder="${esc(__('ftp.ornek.com'))}" spellcheck="false"></label>
        <label class="db-f"><span>${esc(__('Port'))}</span><input name="port" value="${esc(v.port || '')}" inputmode="numeric" placeholder="21"></label>
        <label class="db-f"><span>${esc(__('Kullanıcı'))}</span><input name="user" value="${esc(v.user || '')}" spellcheck="false" autocomplete="off"></label>
        <label class="db-f iftp-sftp"><span>${esc(__('Kimlik doğrulama'))}</span><select name="auth"><option value="password"${sel(v.auth, 'password')}>${esc(__('Parola'))}</option><option value="key"${sel(v.auth, 'key')}>${esc(__('Özel anahtar dosyası'))}</option><option value="agent"${sel(v.auth, 'agent')}>${esc(__('SSH ajanı / Pageant'))}</option></select></label>
        <label class="db-f iftp-pw"><span>${esc(__('Parola'))}</span><input type="password" name="pw" autocomplete="new-password" placeholder="${esc(c && c.hasPassword ? __('Kayıtlı parola değişmez') : '')}"></label>
        <label class="db-f full iftp-key"><span>${esc(__('Özel anahtar (OpenSSH ya da PuTTY .ppk)'))}</span><input name="keyPath" value="${esc(v.keyPath || '')}" spellcheck="false" placeholder="C:\\Users\\…\\.ssh\\id_ed25519"></label>
        <label class="db-f full iftp-key"><span>${esc(__('Anahtar parolası (passphrase)'))}</span><input type="password" name="pp" autocomplete="new-password" placeholder="${esc(c && c.hasPassphrase ? __('Kayıtlı parola değişmez') : __('Anahtar şifreliyse'))}"></label>
        <div class="db-f full db-row">
          <label class="db-ck"><input type="checkbox" name="askPassword"${chk(v.askPassword)}><span>${esc(__('Parolayı kaydetme, her bağlanışta sor'))}</span></label>
          ${c && (c.hasPassword || c.hasPassphrase) ? `<button type="button" class="db-link" data-mb="clearPw">${esc(__('Kayıtlı parolayı sil'))}</button>` : ''}
        </div>
        ${!X.canEncrypt ? `<p class="db-note warn full"><i class="fa-solid fa-triangle-exclamation"></i>${esc(__('Bu bilgisayarda şifreleme kullanılamıyor; parolalar yalnızca oturum boyunca bellekte tutulur.'))}</p>` : ''}
        <label class="db-f wide"><span>${esc(__('Kök klasör (sunucuda)'))}</span><input name="root" value="${esc(v.root || '/')}" spellcheck="false" placeholder="/"></label>
        <label class="db-f"><span>${esc(__('Web adresi'))}</span><input name="webUrl" value="${esc(v.webUrl || '')}" spellcheck="false" placeholder="https://ornek.com"></label>
        <label class="db-ck full iftp-tls"><input type="checkbox" name="insecure"${chk(v.insecure)}><span>${esc(__('Kendinden imzalı sertifikayı kabul et (FTPS)'))}</span></label>
        <label class="db-ck full"><input type="checkbox" name="keepTime"${chk(v.timeMode !== 'off')}><span>${esc(__('Yüklerken dosyanın değiştirilme zamanını koru (sunucu destekliyorsa)'))}</span></label>
        <label class="db-f full"><span>${esc(__('Claude / Codex erişimi · bağlantıyı VoxStorm kurar, adres ve parola ajana verilmez'))}</span><select name="aiAccess"><option value=""${sel(v.aiAccess || '', '')}>${esc(__('Her oturumda ilk kullanımda sor'))}</option><option value="allow"${sel(v.aiAccess, 'allow')}>${esc(__('Her zaman izin ver'))}</option><option value="deny"${sel(v.aiAccess, 'deny')}>${esc(__('Asla izin verme (ajanlar bu bağlantıyı görmez)'))}</option></select></label>
      </div>`;
    const draft = (f, form) => ({ id: c ? c.id : undefined, type: form.querySelector('[name=type]:checked').value, name: f.name, group: f.group, host: f.host, port: f.port, user: f.user, auth: f.auth, keyPath: f.keyPath, root: f.root, webUrl: f.webUrl, insecure: f.insecure, timeMode: f.keepTime ? 'keep' : 'off', askPassword: f.askPassword, aiAccess: f.aiAccess, pw: f.pw || undefined, pp: f.pp || undefined });
    let savedId = null;
    const r = await dbApi.modal({
      title: c ? __('FTP sunucusunu düzenle') : __('Yeni FTP sunucusu'), icon: 'fa-cloud-arrow-up', wide: true, body,
      buttons: [...(c ? [['delete', __('Sil'), 'iftp-delbtn']] : []), ['test', __('Bağlantıyı dene')], ['cancel', __('Vazgeç')], ['save', __('Kaydet'), 'primary']],
      onOpen: form => {
        const sync = () => {
          const t = form.querySelector('[name=type]:checked').value, auth = form.querySelector('[name=auth]').value;
          form.classList.toggle('t-sftp', t === 'sftp');
          form.classList.toggle('t-tls', t === 'ftps' || t === 'ftps-implicit');
          form.classList.toggle('a-key', t === 'sftp' && auth === 'key');
          form.classList.toggle('a-agent', t === 'sftp' && auth === 'agent');
          const def = t === 'sftp' ? '22' : t === 'ftps-implicit' ? '990' : '21', port = form.querySelector('[name=port]');
          port.placeholder = def;
          if (['21', '22', '990'].includes(port.value.trim())) port.value = def; // a default port follows the type
        };
        form.addEventListener('change', sync); sync();
      },
      onAction: async (act, f, form) => {
        if (act === 'clearPw') { await inv('ftp:save', { ...draft(f, form), pw: undefined, pp: undefined, clearPw: true }); await loadServers(); toast(__('Kayıtlı parola silindi')); form.querySelector('[data-mb=clearPw]').remove(); return true; }
        if (act === 'delete') {
          if (!(await uiConfirm({ title: __('Sunucuyu sil'), message: __('“{name}” kaydı ve kayıtlı parolası silinecek. Bu sunucuyu kullanan projelerin deployment ayarı boşalır.', { name: c.name || c.host }), ok: __('Sil'), danger: true }))) return true;
          await inv('ftp:delete', c.id); savedId = null; return false;
        }
        if (!f.host.trim()) { form.querySelector('[name=host]').focus(); toast(__('Sunucu adresi gerekli')); return true; }
        if (act === 'test') {
          const b = form.querySelector('[data-mb=test]'); b.disabled = true; const old = b.textContent; b.textContent = __('Deneniyor…');
          let t = await inv('ftp:test', draft(f, form));
          // SFTP host key changed: show both fingerprints, trust the new one only when the user says so
          if (err(t) && t.hostKey && await uiConfirm({ title: __('UYARI: Sunucu anahtarı değişmiş!'), danger: true, icon: 'fa-shield-halved',
            message: __('Kayıtlı anahtar ile gelen anahtar farklı. Sunucu yeniden kurulmuş olabilir; ama biri araya girip bağlantıyı dinliyor da olabilir (man-in-the-middle).'),
            detail: __('Kayıtlı') + ': ' + t.hostKey.old + '\n' + __('Gelen') + ': ' + t.hostKey.fp, ok: __('Yeni anahtarı kabul et') })) {
            await inv('ftp:trustKey', t.hostKey.host, t.hostKey.port, t.hostKey.fp);
            t = await inv('ftp:test', draft(f, form));
          }
          b.disabled = false; b.textContent = old;
          if (err(t)) toast(__('Bağlanılamadı'), t.error); else toast(__('Bağlantı başarılı'), __('Kök klasörde {n} öğe var.', { n: t.count }));
          return true;
        }
        const saved = await inv('ftp:save', draft(f, form));
        if (err(saved)) { toast(__('Kaydedilemedi'), saved.error); return true; }
        savedId = saved.id;
        return false;
      },
    });
    await loadServers();
    if (r && r.value === 'delete') { await loadDeploy(); return null; }
    if (!r || r.value !== 'save') return null;
    X.kids = {}; X.connected.delete(savedId);
    render();
    const s = curSrv(); if (s && s.id === savedId) loadDir(s.root || '/', true);
    return savedId;
  }

  /* ---------------- deployment settings (this project) ---------------- */
  async function deploySettings() {
    if (!X.root) return;
    await loadServers();
    const d = X.dep || { server: '', auto: 'off', excludes: [], maps: {} };
    let sid = d.server || (X.servers[0] && X.servers[0].id) || '';
    const maps = JSON.parse(JSON.stringify(d.maps || {}));
    const mapRows = () => {
      const list = maps[sid] && maps[sid].length ? maps[sid] : [{ local: '', remote: '/' }];
      maps[sid] = list;
      return list.map((m, i) => `<div class="iftp-map" data-mi="${i}"><input data-ml="${i}" value="${esc(m.local)}" placeholder="${esc(__('(proje kökü)'))}" spellcheck="false" aria-label="${esc(__('Yerel klasör'))}"><i class="fa-solid fa-arrow-right-arrow-left"></i><input data-mr="${i}" value="${esc(m.remote)}" placeholder="/" spellcheck="false" aria-label="${esc(__('Sunucudaki klasör'))}"><button type="button" class="db-ib" data-mb="delMap${i}" title="${esc(__('Eşlemeyi kaldır'))}" aria-label="${esc(__('Eşlemeyi kaldır'))}"${list.length < 2 ? ' disabled' : ''}><i class="fa-solid fa-xmark"></i></button></div>`).join('');
    };
    const s0 = srv(sid);
    const body = `
      <p class="db-muted">${esc(__('Proje: {path}', { path: X.root }))}</p>
      <div class="db-grid2">
        <label class="db-f full"><span>${esc(__('Varsayılan sunucu'))}</span><select name="server">${X.servers.map(x => `<option value="${esc(x.id)}"${x.id === sid ? ' selected' : ''}>${esc((x.name || x.host) + ' · ' + TYPE_LABEL[x.type])}</option>`).join('') || `<option value="">${esc(__('Önce bir sunucu ekle'))}</option>`}</select></label>
        <div class="db-f full"><span>${esc(__('Eşlemeler · yerel klasör (projeye göre) ↔ sunucudaki klasör (kök klasöre göre)'))}</span><div id="iftpMaps">${sid ? mapRows() : ''}</div><button type="button" class="db-link iftp-addmap" data-mb="addMap"><i class="fa-solid fa-plus"></i> ${esc(__('Eşleme ekle'))}</button><small class="db-muted" id="iftpRootNote">${esc(s0 ? __('Sunucunun kök klasörü: {root}', { root: s0.root }) : '')}</small></div>
        <label class="db-f full"><span>${esc(__('Hariç tutulanlar · her satıra bir ad, yol ya da *.uzantı'))}</span><textarea name="excludes" rows="4" spellcheck="false">${esc((d.excludes || []).join('\n'))}</textarea></label>
        <label class="db-f wide"><span>${esc(__('Otomatik yükleme'))}</span><select name="auto">
          <option value="off"${d.auto === 'off' ? ' selected' : ''}>${esc(__('Kapalı'))}</option>
          <option value="save"${d.auto === 'save' ? ' selected' : ''}>${esc(__('IDE’de kaydedince'))}</option>
          <option value="always"${d.auto === 'always' ? ' selected' : ''}>${esc(__('Her değişiklikte (dışarıdan yapılanlar ve Claude’un düzenlemeleri dahil)'))}</option></select></label>
        <label class="db-ck iftp-delck"><input type="checkbox" name="delRemote"${d.delRemote ? ' checked' : ''}><span>${esc(__('Projeden silinen dosyayı sunucudan da sil (“her değişiklikte” ile)'))}</span></label>
      </div>`;
    const readMaps = form => {
      if (!sid) return;
      maps[sid] = [...form.querySelectorAll('.iftp-map')].map(r => ({ local: r.querySelector('[data-ml]').value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), remote: r.querySelector('[data-mr]').value.trim() || '/' }));
    };
    const r = await dbApi.modal({
      title: __('Deployment ayarları'), icon: 'fa-sliders', wide: true, body,
      buttons: [['cancel', __('Vazgeç')], ['save', __('Kaydet'), 'primary']],
      onOpen: form => {
        form.addEventListener('change', e => {
          if (e.target.name === 'server') {
            readMaps(form); sid = e.target.value;
            form.querySelector('#iftpMaps').innerHTML = mapRows();
            const s = srv(sid); form.querySelector('#iftpRootNote').textContent = s ? __('Sunucunun kök klasörü: {root}', { root: s.root }) : '';
          }
        });
      },
      onAction: async (act, f, form) => {
        if (act === 'addMap') { readMaps(form); maps[sid].push({ local: '', remote: '/' }); form.querySelector('#iftpMaps').innerHTML = mapRows(); return true; }
        if (act.startsWith('delMap')) { readMaps(form); maps[sid].splice(+act.slice(6), 1); form.querySelector('#iftpMaps').innerHTML = mapRows(); return true; }
        if (act === 'save') {
          readMaps(form);
          await saveDeploy({ server: f.server, auto: f.auto, excludes: f.excludes.split(/\r?\n/), maps, delRemote: f.delRemote });
          return false;
        }
        return false;
      },
    });
    if (r && r.value === 'save') { toast(__('Deployment ayarları kaydedildi')); loadDeploy(); }
  }

  /* ---------------- file tree / tab menu ---------------- */
  const has = () => !!(X.dep && X.dep.server && srv(X.dep.server));
  function menuHtml(it, sep, ctx) {
    if (!X.root || ctx.kind === 'dock') return '';
    const s = curSrv();
    const name = s ? (s.name || s.host) : '';
    const isDir = ctx.kind === 'tree' && (!ctx.path || ctx.dir);
    if (!s) return sep + it('ftpSetup', 'fa-solid fa-cloud-arrow-up', __('Deployment ayarla…'));
    return sep + `<div class="lbl iftp-mlbl"><i class="fa-solid fa-cloud-arrow-up"></i> ${esc(__('Deployment · {name}', { name }))}</div>`
      + it('ftpUp', 'fa-solid fa-arrow-up-from-bracket', __('Sunucuya yükle'))
      + it('ftpDown', 'fa-solid fa-download', __('Sunucudan indir'))
      + (isDir ? it('ftpSync', 'fa-solid fa-right-left', __('Sunucuyla senkronize et')) : it('ftpCmp', 'fa-solid fa-code-compare', __('Sunucudakiyle karşılaştır')));
  }
  async function menuAction(act, fp, isDir) {
    if (!X.built) await ensure();
    if (X.project !== IDE.project) await loadDeploy();
    if (act === 'ftpSetup') { showPanel(); deploySettings(); return true; }
    if (!has()) { toast(__('Deployment sunucusu yok'), __('Deployment panelinden bu proje için bir sunucu seç.')); return true; }
    if (act === 'ftpUp') { await transfer('ftp:upload', [fp]); return true; }
    if (act === 'ftpDown') {
      if (!(await uiConfirm({ title: __('Sunucudan indir'), message: isDir ? __('“{name}” klasörü sunucudaki haliyle güncellenecek; değişen yerel dosyaların üzerine yazılır.', { name: relOf(fp) || baseName(fp) }) : __('“{name}” sunucudaki haliyle değiştirilecek.', { name: relOf(fp) }), ok: __('İndir') }))) return true;
      const r = await transfer('ftp:download', [fp]);
      if (r && r.done && !isDir && window.reloadFromDisk) reloadFromDisk(fp, true);
      return true;
    }
    if (act === 'ftpCmp') { compareFile(fp); return true; }
    if (act === 'ftpSync') { syncDialog(normPath(fp) === normPath(X.root) ? '' : relOf(fp).replace(/\\/g, '/')); return true; }
    return false;
  }
  function showPanel() { if (typeof dockIdeShow === 'function') dockIdeShow('iftp'); }

  /* ---------------- wiring ---------------- */
  async function ensure() {
    if (X.built) return;
    X.built = true;
    build();
    await loadServers();
    await loadDeploy();
    api.on('ftp:changed', async () => { await loadServers(); render(); });
    api.on('ftp:state', st => { if (st.connected) X.connected.add(st.id); else X.connected.delete(st.id); renderTree(); });
    api.on('ftp:log', l => {
      const s = srv(l.server);
      if (l.kind === 'error') { status(l.error, 'err'); toast(__('Otomatik yükleme başarısız'), (l.local ? baseName(l.local) + ': ' : '') + l.error); return; }
      const what = l.local ? (relOf(l.local) || baseName(l.local)) : l.remote;
      status(l.kind === 'up' ? __('Yüklendi: {path} → {name}', { path: what, name: s ? s.name || s.host : '' }) : l.kind === 'del' ? __('Sunucudan silindi: {path}', { path: what }) : __('İndirildi: {path}', { path: what }));
      const dir = l.remote && rparent(l.remote);
      if (dir && X.kids[dir]) loadDir(dir, true);
    });
    // the IDE switched project: show that project's server
    setInterval(() => { if (X.project !== IDE.project) loadDeploy(); }, 1000);
    // shown for the first time (or again): list the server's root folder
    new ResizeObserver(() => { const s = curSrv(); if (s && visible() && !X.kids[s.root || '/']) loadDir(s.root || '/'); }).observe(byId('iftpSide'));
  }
  // an IDE save: upload when the project's automatic upload is on (main checks the setting)
  function saved(fp) { api.invoke('ftp:saved', fp).catch(() => {}); }

  window.ideFtp = { ensure, saved, menuHtml, menuAction, hasDeploy: has, show: showPanel };
})();
