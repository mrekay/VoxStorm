/* VoxStorm SSH mode: PuTTY + WinSCP in one place.
   Saved hosts on the left; each session tab has a terminal and a two-pane file manager
   (this computer on the left, the server on the right) with a transfer queue, a remote file
   editor and local port forwarding. RDP hosts open Remote Desktop (mstsc on Windows, Windows App on macOS).
   Works on Windows and macOS: local paths use SEP, app shortcuts use modKey (Cmd on macOS).
   Everything that touches a server runs in the main process (src/main/ssh.js).
   Uses globals from app.js: $, esc, toast, termTheme, MODES, extOf, SHORTCUTS. */
/* global api, Terminal, FitAddon, CodeMirror */
(() => {
  'use strict';
  const view = document.getElementById('sshView');
  const COLORS = [['', __('Yok')], ['red', __('Kırmızı')], ['orange', __('Turuncu')], ['yellow', __('Sarı')], ['green', __('Yeşil')], ['blue', __('Mavi')], ['purple', __('Mor')], ['gray', __('Gri')]];
  const errText = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const inv = async (ch, ...a) => { try { return await api.invoke(ch, ...a); } catch (e) { return { error: errText(e) }; } };
  const uid = () => 't' + Math.random().toString(36).slice(2, 10);
  const fmtSize = n => {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toLocaleString(I18N.locale(), { maximumFractionDigits: n < 10 ? 1 : 0 }) + ' ' + u[i];
  };
  const fmtDate = ms => {
    if (!ms) return '';
    const d = new Date(ms), p = x => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const rjoin = (a, b) => (a.endsWith('/') ? a + b : a + '/' + b);
  const rparent = p => { if (!p || p === '/') return '/'; const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  const LSEP = typeof SEP === 'string' ? SEP : '\\';
  const ljoin = (a, b) => (/[\\/]$/.test(a) ? a + b : a + LSEP + b);
  const lparent = p => { if (LSEP === '/') { if (!p || p === '/') return '/'; const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
    if (!p) return ''; if (/^[A-Za-z]:\\?$/.test(p)) return ''; const t = p.replace(/[\\/]+$/, ''); const i = t.lastIndexOf('\\'); return i < 0 ? '' : (i === 2 ? t.slice(0, 3) : t.slice(0, i)); };
  const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

  const X = {
    built: false, hosts: [], canEncrypt: true, home: '',
    filter: '', tabs: [], active: null, cur: null, // cur: selected host id in the list
    ui: { sideW: 250, split: 0.5, hidden: false, localDir: '' },
    xfers: new Map(), collapsed: {},
  };
  const host = id => X.hosts.find(h => h.id === id);
  const tab = id => X.tabs.find(t => t.id === id);
  const curTab = () => tab(X.active);
  const hostLabel = h => (h ? h.name || `${h.user ? h.user + '@' : ''}${h.host}` : '');
  const hostAddr = h => (h ? `${h.user ? h.user + '@' : ''}${h.host}${h.port && h.port !== (h.kind === 'rdp' ? 3389 : 22) ? ':' + h.port : ''}` : '');

  /* ---------------- persistence ---------------- */
  let stTimer = null;
  function saveState() {
    clearTimeout(stTimer);
    stTimer = setTimeout(() => api.invoke('ssh:setState', { ui: X.ui, collapsed: X.collapsed }).catch(() => {}), 500);
  }

  /* ---------------- build ---------------- */
  function build() {
    view.innerHTML = `
      <aside class="ssh-side" aria-label="${esc(__('Sunucular'))}">
        <div class="ssh-side-h"><b>${__('Sunucular')}</b><span class="ssh-grow"></span>
          <button class="ssh-ib" data-act="newHost" title="${esc(__('Yeni bağlantı (Ctrl+Alt+N)'))}" aria-label="${esc(__('Yeni bağlantı'))}"><i class="fa-solid fa-plus"></i></button></div>
        <div class="ssh-search"><i class="fa-solid fa-magnifying-glass"></i><input id="sshFilter" placeholder="${esc(__('Ara…'))}" spellcheck="false" autocomplete="off" aria-label="${esc(__('Sunucu ara'))}"></div>
        <div class="ssh-hosts" id="sshHosts" tabindex="0" role="listbox" aria-label="${esc(__('Kayıtlı sunucular'))}"></div>
      </aside>
      <div class="ssh-split-v" data-drag="side" title="${esc(__('Sürükleyerek genişlet'))}"></div>
      <main class="ssh-main">
        <div class="ssh-tabs" id="sshTabs" role="tablist"></div>
        <div class="ssh-body" id="sshBody"></div>
      </main>
      <div class="db-modal" id="sshModal" hidden></div>
      <div class="db-ctx" id="sshCtx" hidden role="menu"></div>`;
    bind();
    X.built = true;
  }

  /* ---------------- host list ---------------- */
  function renderHosts() {
    const el = document.getElementById('sshHosts'); if (!el) return;
    const q = X.filter.toLowerCase();
    const list = X.hosts.filter(h => !q || [h.name, h.host, h.user, h.group].some(v => (v || '').toLowerCase().includes(q)));
    if (!X.hosts.length) {
      el.innerHTML = `<div class="ssh-hempty"><i class="fa-solid fa-server"></i><b>${__('Kayıtlı sunucu yok')}</b><span>${__('SSH/SFTP ya da Uzak Masaüstü (RDP) bağlantısı ekle.')}</span><button class="btn primary" data-act="newHost"><i class="fa-solid fa-plus"></i> ${__('Yeni bağlantı')}</button></div>`;
      return;
    }
    const groups = new Map();
    for (const h of list) { const g = h.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(h); }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'tr')));
    let html = '';
    for (const g of keys) {
      const shut = !q && X.collapsed[g];
      if (g) html += `<div class="ssh-grp" data-grp="${esc(g)}"><i class="fa-solid fa-chevron-${shut ? 'right' : 'down'}"></i>${esc(g)}<span>${groups.get(g).length}</span></div>`;
      if (shut) continue;
      for (const h of groups.get(g)) {
        const live = X.tabs.filter(t => t.hostId === h.id && t.status === 'ok').length;
        html += `<div class="ssh-host${X.cur === h.id ? ' cur' : ''}${g ? ' in-grp' : ''} db-c-${h.color || 'none'}" data-host="${h.id}" role="option" aria-selected="${X.cur === h.id}" draggable="true" title="${esc(__('{addr} · çift tık: bağlan', { addr: hostAddr(h) }))}">
          <i class="fa-solid ${h.kind === 'rdp' ? 'fa-desktop' : 'fa-terminal'} ssh-hi"></i>
          <span class="ssh-hn"><b>${esc(hostLabel(h))}</b><small>${esc(h.kind === 'rdp' ? 'RDP · ' + hostAddr(h) : hostAddr(h))}</small></span>
          ${live ? `<span class="ssh-live" title="${esc(__('{n} açık oturum', { n: live }))}">${live}</span>` : ''}
          <button class="ssh-ib sm" data-hostmenu="${h.id}" title="${esc(__('Diğer işlemler'))}" aria-label="${esc(__('Diğer işlemler'))}"><i class="fa-solid fa-ellipsis"></i></button>
        </div>`;
      }
    }
    el.innerHTML = html || `<div class="ssh-hnone">${__('Eşleşen sunucu yok.')}</div>`;
  }
  async function loadHosts() {
    const r = await inv('ssh:list');
    X.hosts = r.hosts || [];
    X.canEncrypt = r.canEncrypt !== false;
    X.home = r.home || '';
  }

  /* ---------------- tabs ---------------- */
  function renderTabs() {
    const el = document.getElementById('sshTabs'); if (!el) return;
    el.innerHTML = X.tabs.map(t => {
      const h = host(t.hostId);
      const st = t.status === 'ok' ? 'ok' : t.status === 'connecting' ? 'busy' : 'off';
      return `<div class="ssh-tab${t.id === X.active ? ' on' : ''} db-c-${(h && h.color) || 'none'}" data-stab="${t.id}" role="tab" aria-selected="${t.id === X.active}" title="${esc(hostAddr(h))}">
        <span class="ssh-dot ${st}"></span><span class="ssh-tt">${esc(t.title)}</span>
        <button class="ssh-tx" data-sclose="${t.id}" title="${esc(__('Kapat'))}" aria-label="${esc(__('Sekmeyi kapat'))}"><i class="fa-solid fa-xmark"></i></button></div>`;
    }).join('') + `<button class="ssh-tadd" data-act="pickHost" title="${esc(__('Yeni oturum'))}" aria-label="${esc(__('Yeni oturum'))}"><i class="fa-solid fa-plus"></i></button>`;
    const body = document.getElementById('sshBody');
    if (!X.tabs.length && !body.querySelector('.ssh-empty')) {
      body.querySelectorAll('.ssh-sess').forEach(x => { x.hidden = true; });
      body.insertAdjacentHTML('beforeend', `<div class="ssh-empty"><i class="fa-solid fa-network-wired"></i><b>${__('Açık oturum yok')}</b><span>${__('Soldaki listeden bir sunucuya çift tıkla ya da yeni bağlantı ekle.')}</span>
        <dl class="en-keys"><dt>${__('Yeni bağlantı')}</dt><dd><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>N</kbd></dd><dt>${__('Sekmeyi kapat')}</dt><dd><kbd>Ctrl</kbd><kbd>W</kbd></dd><dt>${__('Terminal / Dosyalar')}</dt><dd><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>T</kbd> / <kbd>F</kbd></dd><dt>${__('Diğer tarafa aktar')}</dt><dd><kbd>F5</kbd></dd></dl></div>`);
    } else if (X.tabs.length) { const e = body.querySelector('.ssh-empty'); if (e) e.remove(); }
  }
  function activate(id) {
    const t = tab(id); if (!t) return;
    X.active = id;
    X.tabs.forEach(x => { x.el.hidden = x.id !== id; });
    renderTabs();
    requestAnimationFrame(() => { fitTerm(t); if (t.view === 'term') t.term.focus(); });
  }
  function closeTab(id) {
    const t = tab(id); if (!t) return;
    if (t.kind === 'term') { if (t.ch) api.send('ssh:closeShell', t.ch); }
    else if (t.sid) inv('ssh:disconnect', t.sid);
    if (t.dock) t.dock.destroy();
    if (t.ro) t.ro.disconnect();
    try { t.term.dispose(); } catch (_) {}
    t.el.remove();
    const i = X.tabs.indexOf(t);
    X.tabs.splice(i, 1);
    if (X.active === id) { const n = X.tabs[Math.min(i, X.tabs.length - 1)]; X.active = n ? n.id : null; if (n) activate(n.id); }
    renderTabs(); renderHosts();
  }
  function cycleTab(d) {
    if (!X.tabs.length) return;
    const i = X.tabs.findIndex(t => t.id === X.active);
    activate(X.tabs[(i + d + X.tabs.length) % X.tabs.length].id);
  }

  /* ---------------- session ---------------- */
  function sameTitle(h) {
    const n = X.tabs.filter(t => t.hostId === h.id).length;
    return hostLabel(h) + (n ? ` (${n + 1})` : '');
  }
  function openSession(hostId, viewMode) {
    const h = host(hostId); if (!h) return;
    if (h.kind === 'rdp') { openRdp(h); return; }
    const t = {
      id: uid(), hostId, title: sameTitle(h), status: 'connecting', error: '', sid: null, ch: null, view: viewMode || 'split', home: '',
      local: { side: 'local', path: h.localDir || X.ui.localDir || X.home, items: [], sel: new Set(), sort: { k: 'name', d: 1 }, anchor: -1, focus: 0 },
      remote: { side: 'remote', path: '', items: [], sel: new Set(), sort: { k: 'name', d: 1 }, anchor: -1, focus: 0 },
      tunnels: [], hist: { local: [], remote: [] },
    };
    t.el = document.createElement('div');
    t.el.className = 'ssh-sess';
    t.el.dataset.sess = t.id;
    t.el.innerHTML = `
      <div class="ssh-bar">
        <span class="ssh-dot busy" data-role="dot"></span>
        <span class="ssh-addr" data-role="addr">${esc(hostAddr(h))}</span>
        <div class="db-seg ssh-vseg" role="tablist" aria-label="${esc(__('Görünüm'))}">
          <button data-view="term" title="${esc(__('Yalnızca terminal (Ctrl+Alt+T)'))}"><i class="fa-solid fa-terminal"></i>${__('Terminal')}</button>
          <button data-view="split" title="${esc(__('Dosyalar ve terminal birlikte'))}"><i class="fa-solid fa-table-columns fa-rotate-90"></i>${__('İkisi')}</button>
          <button data-view="files" title="${esc(__('Yalnızca dosyalar (Ctrl+Alt+F)'))}"><i class="fa-regular fa-folder-open"></i>${__('Dosyalar')}</button>
          <button data-view="docker" title="${esc(__('Sunucudaki Docker konteynerleri'))}"><i class="fa-brands fa-docker"></i>Docker</button>
        </div>
        <span class="ssh-grow"></span>
        <button class="ssh-tb" data-act="tunnels" title="${esc(__('Port yönlendirme (tüneller)'))}"><i class="fa-solid fa-route"></i>${__('Tüneller')}<b class="ssh-cnt" data-role="tcount" hidden></b></button>
        <button class="ssh-tb" data-act="dupSess" title="${esc(__('Aynı sunucuya yeni oturum'))}"><i class="fa-regular fa-clone"></i>${__('Çoğalt')}</button>
        <button class="ssh-tb" data-act="reconnect" data-role="recon" title="${esc(__('Yeniden bağlan'))}"><i class="fa-solid fa-plug-circle-bolt"></i>${__('Yeniden bağlan')}</button>
        <button class="ssh-tb danger" data-act="disconnect" data-role="disc" title="${esc(__('Bağlantıyı kes'))}"><i class="fa-solid fa-plug-circle-xmark"></i>${__('Kes')}</button>
      </div>
      <div class="ssh-content">
        <div class="ssh-files">
          <div class="ssh-panes">
            ${paneHtml('local')}
            <div class="ssh-mid">
              <button class="ssh-ib" data-act="upload" title="${esc(__('Seçilenleri sunucuya yükle (sol panelde F5)'))}" aria-label="${esc(__('Yükle'))}"><i class="fa-solid fa-arrow-right"></i></button>
              <button class="ssh-ib" data-act="download" title="${esc(__('Seçilenleri bu bilgisayara indir (sağ panelde F5)'))}" aria-label="${esc(__('İndir'))}"><i class="fa-solid fa-arrow-left"></i></button>
            </div>
            ${paneHtml('remote')}
          </div>
          <div class="ssh-xfers" data-role="xfers" hidden></div>
        </div>
        <div class="ssh-split-h" data-drag="split" title="${esc(__('Sürükleyerek boyutlandır'))}"></div>
        <div class="ssh-term"><div class="ssh-termhost" data-role="term"></div></div>
        <div class="ssh-dock" data-role="docker"></div>
        <div class="ssh-over" data-role="over"></div>
      </div>`;
    document.getElementById('sshBody').appendChild(t.el);
    const term = new Terminal({
      fontFamily: MONO_FONT, fontSize: 13, lineHeight: 1.15,
      cursorBlink: true, scrollback: 10000, allowProposedApi: true, theme: termTheme(), linkHandler: typeof termLinkHandler !== 'undefined' ? termLinkHandler : undefined,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    t.term = term; t.fit = fit;
    term.open(t.el.querySelector('[data-role=term]'));
    term.onData(d => {
      if (t.ch) api.send('ssh:write', t.ch, d);
      else if (t.status === 'ok' && d === '\r') openShell(t);
    });
    term.onResize(({ cols, rows }) => { if (t.ch) api.send('ssh:resize', t.ch, cols, rows); });
    term.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (!IS_MAC && e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
        if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); }
        return false;
      }
      if (!IS_MAC && e.ctrlKey && k === 'v') return false; // the browser paste event delivers the text
      return true;
    });
    // PuTTY habit: right click copies the selection, or pastes when nothing is selected
    t.el.querySelector('.ssh-term').addEventListener('contextmenu', async e => {
      e.preventDefault();
      if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); }
      else { try { const s = await navigator.clipboard.readText(); if (s && t.ch) term.paste(s); } catch (_) {} }
      term.focus();
    });
    t.ro = new ResizeObserver(() => fitTerm(t));
    t.ro.observe(t.el.querySelector('.ssh-term'));
    X.tabs.push(t);
    setView(t, t.view, true);
    activate(t.id);
    renderOver(t);
    connectTab(t);
    return t;
  }
  function paneHtml(side) {
    const remote = side === 'remote';
    return `<section class="ssh-pane" data-pane="${side}" aria-label="${esc(remote ? __('Sunucu') : __('Bu bilgisayar'))}">
      <div class="ssh-ph">
        <span class="ssh-pt"><i class="fa-solid ${remote ? 'fa-server' : 'fa-laptop'}"></i>${remote ? __('Sunucu') : __('Bu bilgisayar')}</span>
        <button class="ssh-ib sm" data-spact="back" title="${esc(__('Geri (Alt+Sol)'))}" aria-label="${esc(__('Geri'))}"><i class="fa-solid fa-arrow-left"></i></button>
        <button class="ssh-ib sm" data-spact="up" title="${esc(__('Üst klasör (Backspace)'))}" aria-label="${esc(__('Üst klasör'))}"><i class="fa-solid fa-arrow-turn-up"></i></button>
        <button class="ssh-ib sm" data-spact="home" title="${esc(remote ? __('Ev klasörü') : __('Kullanıcı klasörü'))}" aria-label="${esc(__('Ev klasörü'))}"><i class="fa-solid fa-house"></i></button>
        <input class="ssh-path" data-role="path" spellcheck="false" autocomplete="off" aria-label="${esc(__('Yol'))}" title="${esc(__("Bir yol yaz ve Enter'a bas"))}">
        <button class="ssh-ib sm" data-spact="refresh" title="${esc(__('Yenile (Ctrl+R)'))}" aria-label="${esc(__('Yenile'))}"><i class="fa-solid fa-arrows-rotate"></i></button>
        <button class="ssh-ib sm" data-spact="mkdir" title="${esc(__('Yeni klasör (F7)'))}" aria-label="${esc(__('Yeni klasör'))}"><i class="fa-solid fa-folder-plus"></i></button>
        ${remote ? `<button class="ssh-ib sm" data-spact="touch" title="${esc(__('Yeni dosya'))}" aria-label="${esc(__('Yeni dosya'))}"><i class="fa-solid fa-file-circle-plus"></i></button>` : `<button class="ssh-ib sm" data-spact="pick" title="${esc(__('Klasör seç…'))}" aria-label="${esc(__('Klasör seç'))}"><i class="fa-regular fa-folder-open"></i></button>`}
      </div>
      <div class="ssh-lh ${remote ? 'rem' : ''}"><span data-sort="name">${__('Ad')}</span><span data-sort="size">${__('Boyut')}</span><span data-sort="mtime">${__('Değişiklik')}</span>${remote ? `<span data-sort="perm">${__('İzinler')}</span><span data-sort="owner">${__('Sahip')}</span>` : ''}</div>
      <div class="ssh-list ${remote ? 'rem' : ''}" data-role="list" tabindex="0"></div>
      <div class="ssh-pf" data-role="foot"></div>
    </section>`;
  }
  function setView(t, v, quiet) {
    if (t.kind === 'term') return;
    t.view = v;
    const c = t.el.querySelector('.ssh-content');
    c.dataset.layout = v;
    c.style.setProperty('--ssh-split', Math.round(X.ui.split * 100) + '%');
    t.el.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'docker') mountDocker(t);
    if (!quiet) requestAnimationFrame(() => { fitTerm(t); if (v === 'term') t.term.focus(); else if (v !== 'docker') paneEl(t, 'remote').querySelector('[data-role=list]').focus(); });
  }
  // the session's Docker view: containers on that server, run over the SSH connection
  function mountDocker(t) {
    if (!window.DockerUI || !t.sid) return;
    if (t.dock) { t.dock.setTarget(t.sid); return; }
    t.dock = DockerUI.mount(t.el.querySelector('[data-role=docker]'), {
      target: t.sid,
      onTerminal: c => openDockerTerm({ ...c, host: hostLabel(host(t.hostId)) }),
    });
  }
  function fitTerm(t) {
    if (!t || t.view === 'files' || t.view === 'docker' || !t.el.offsetParent) return;
    try { t.fit.fit(); } catch (_) {}
  }
  function renderBar(t) {
    const st = t.status === 'ok' ? 'ok' : t.status === 'connecting' ? 'busy' : 'off';
    t.el.querySelector('[data-role=dot]').className = 'ssh-dot ' + st;
    t.el.querySelector('[data-role=disc]').hidden = t.status !== 'ok';
    t.el.querySelector('[data-role=recon]').hidden = t.status === 'ok' || t.status === 'connecting';
    const tc = t.el.querySelector('[data-role=tcount]');
    tc.hidden = !t.tunnels.length; tc.textContent = t.tunnels.length;
  }
  function renderOver(t) {
    const o = t.el.querySelector('[data-role=over]');
    renderBar(t);
    if (t.status === 'ok') { o.hidden = true; o.innerHTML = ''; return; }
    o.hidden = false;
    const h = host(t.hostId);
    if (t.status === 'connecting') o.innerHTML = `<div class="ssh-ob"><i class="fa-solid fa-circle-notch fa-spin"></i><b>${__('Bağlanıyor…')}</b><span>${esc(hostAddr(h))}</span></div>`;
    else o.innerHTML = `<div class="ssh-ob ${t.status === 'error' ? 'bad' : ''}"><i class="fa-solid ${t.status === 'error' ? 'fa-triangle-exclamation' : 'fa-plug-circle-xmark'}"></i><b>${t.status === 'error' ? __('Bağlanılamadı') : __('Bağlantı kapandı')}</b>${t.error ? `<span>${esc(t.error)}</span>` : ''}
      <div class="ssh-obb"><button class="btn primary" data-act="reconnect"><i class="fa-solid fa-plug-circle-bolt"></i> ${__('Yeniden bağlan')}</button><button class="btn" data-act="editThisHost">${__('Bağlantıyı düzenle')}</button></div></div>`;
  }
  async function connectTab(t, opts = {}) {
    const h = host(t.hostId);
    if (!h) { t.status = 'error'; t.error = __('Bağlantı kaydı silinmiş.'); renderOver(t); return; }
    t.status = 'connecting'; t.error = ''; renderOver(t); renderTabs();
    const r = await inv('ssh:connect', h.id, opts);
    if (!tab(t.id)) { if (r.sid) inv('ssh:disconnect', r.sid); return; }
    if (r.needPassword) {
      const a = await askSecret(h, r.what, r.loginFailed ? r.error : '');
      if (!a) { t.status = 'error'; t.error = r.what === 'pp' ? __('Anahtar parolası girilmedi.') : __('Parola girilmedi.'); renderOver(t); renderTabs(); return; }
      return connectTab(t, { ...opts, [r.what === 'pp' ? 'passphrase' : 'password']: a.value, remember: a.remember });
    }
    if (r.hostKey) {
      const ok = await askHostKey(h, r);
      if (!ok) { t.status = 'error'; t.error = __('Sunucu anahtarı onaylanmadı.'); renderOver(t); renderTabs(); return; }
      return connectTab(t, { ...opts, acceptKey: r.hostKey });
    }
    if (r.error) { t.status = 'error'; t.error = r.error; renderOver(t); renderTabs(); return; }
    t.sid = r.sid; t.home = r.home || '/'; t.status = 'ok'; t.tunnels = r.tunnels || [];
    if (r.tunnelErrors && r.tunnelErrors.length) toast(__('Bazı tüneller açılamadı'),r.tunnelErrors.join(' · '));
    if (opts.password !== undefined || opts.passphrase !== undefined) loadHosts().then(renderHosts);
    renderOver(t); renderTabs(); renderHosts();
    t.term.write(`\x1b[2m— ${__('{addr} bağlantısı kuruldu', { addr: hostAddr(h) })} —\x1b[0m\r\n`);
    fitTerm(t);
    openShell(t);
    if (!t.remote.path || opts.reconnect !== true) t.remote.path = h.startDir || t.home;
    loadPane(t, 'remote', t.remote.path, true);
    loadPane(t, 'local', t.local.path, true);
    if (t.dock || t.view === 'docker') mountDocker(t);
  }
  async function openShell(t) {
    if (t.ch || t.opening || !t.sid) return;
    t.opening = true;
    fitTerm(t);
    const r = await inv('ssh:shell', t.sid, t.term.cols, t.term.rows);
    t.opening = false;
    if (r.error) { t.term.write(`\r\n\x1b[31m${__('Kabuk açılamadı: {msg}', { msg: r.error })}\x1b[0m\r\n`); return; }
    t.ch = r.ch;
    const h = host(t.hostId);
    if (h && h.startDir && !t.cdDone) { t.cdDone = true; api.send('ssh:write', t.ch, `cd ${shq(h.startDir)}\r`); }
  }
  function disconnect(t) {
    if (t.sid) inv('ssh:disconnect', t.sid);
  }
  const tabBySid = sid => X.tabs.find(t => t.sid === sid && t.kind !== 'term');
  const tabByCh = ch => X.tabs.find(t => t.ch === ch);

  /* ---------------- file panes ---------------- */
  const paneEl = (t, side) => t.el.querySelector(`[data-pane="${side}"]`);
  const P = (t, side) => t[side];
  function sorted(p) {
    const k = p.sort.k, d = p.sort.d;
    const show = X.ui.hidden ? p.items : p.items.filter(f => !f.name.startsWith('.'));
    return show.slice().sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      let r = 0;
      if (k === 'size') r = (a.size || 0) - (b.size || 0);
      else if (k === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
      else if (k === 'perm' || k === 'owner') r = String(a[k] || '').localeCompare(String(b[k] || ''));
      if (!r) r = a.name.localeCompare(b.name, 'tr', { numeric: true, sensitivity: 'base' });
      return r * d;
    });
  }
  async function loadPane(t, side, path, keepSel, noHist) {
    const p = P(t, side);
    if (side === 'remote' && !t.sid) return;
    const prev = p.path;
    p.loading = true; renderPane(t, side);
    const r = side === 'remote' ? await inv('ssh:ls', t.sid, path) : await inv('ssh:localLs', path);
    p.loading = false;
    if (r.error) {
      p.error = r.error;
      if (prev && prev !== path) { toast(__('Açılamadı'), r.error); p.error = ''; }
      renderPane(t, side); return;
    }
    p.error = '';
    if (!noHist && prev && prev !== r.path) { t.hist[side].push(prev); if (t.hist[side].length > 50) t.hist[side].shift(); }
    const keep = keepSel && prev === r.path ? new Set([...p.sel]) : new Set();
    p.path = r.path; p.items = r.items;
    p.sel = new Set([...keep].filter(n => r.items.some(f => f.name === n)));
    if (prev !== r.path) { p.anchor = -1; p.focus = 0; }
    if (side === 'local' && r.path) { X.ui.localDir = r.path; saveState(); }
    renderPane(t, side);
  }
  function renderPane(t, side) {
    const p = P(t, side), el = paneEl(t, side); if (!el) return;
    const inp = el.querySelector('[data-role=path]');
    if (document.activeElement !== inp) inp.value = side === 'local' && !p.path ? __('Bu bilgisayar') : p.path;
    el.querySelectorAll('[data-sort]').forEach(s => { s.classList.toggle('on', s.dataset.sort === p.sort.k); s.dataset.dir = p.sort.d > 0 ? 'asc' : 'desc'; });
    const list = el.querySelector('[data-role=list]');
    el.classList.toggle('loading', !!p.loading);
    if (p.error) { list.innerHTML = `<div class="ssh-lerr"><i class="fa-solid fa-triangle-exclamation"></i>${esc(p.error)}</div>`; renderFoot(t, side); return; }
    const rows = sorted(p);
    p.view = rows;
    const remote = side === 'remote';
    const canUp = remote ? p.path && p.path !== '/' : !!p.path;
    let h = canUp ? `<div class="ssh-row up" data-i="-1"><span class="ssh-fn"><i class="fa-solid fa-arrow-turn-up"></i>..</span><span></span><span></span>${remote ? '<span></span><span></span>' : ''}</div>` : '';
    rows.forEach((f, i) => {
      const ic = f.drive ? 'fa-hard-drive' : f.dir ? 'fa-folder' : fileIcon(f.name);
      h += `<div class="ssh-row${p.sel.has(f.name) ? ' sel' : ''}${i === p.focus ? ' foc' : ''}${f.dir ? ' dir' : ''}${f.name.startsWith('.') ? ' dot' : ''}" data-i="${i}" draggable="true">
        <span class="ssh-fn"><i class="${f.dir ? 'fa-solid' : 'fa-regular'} ${ic}"></i>${esc(f.name)}${f.link ? `<i class="fa-solid fa-link ssh-lnk${f.broken ? ' bad' : ''}" title="${esc(f.broken ? __('Kırık bağlantı') : __('Sembolik bağlantı'))}"></i>` : ''}</span>
        <span class="ssh-fs">${f.dir ? '' : fmtSize(f.size)}</span><span class="ssh-fd">${fmtDate(f.mtime)}</span>${remote ? `<span class="ssh-fp">${esc(f.perm || '')}</span><span class="ssh-fo">${esc(f.owner || '')}</span>` : ''}</div>`;
    });
    if (!rows.length && !p.loading) h += `<div class="ssh-lempty">${p.items.length ? __('Yalnızca gizli dosyalar var') : __('Klasör boş')}</div>`;
    list.innerHTML = h;
    renderFoot(t, side);
  }
  function renderFoot(t, side) {
    const p = P(t, side), el = paneEl(t, side); if (!el) return;
    const rows = p.view || [];
    const sel = rows.filter(f => p.sel.has(f.name));
    const bytes = sel.reduce((a, f) => a + (f.size || 0), 0);
    const hid = p.items.length - rows.length;
    el.querySelector('[data-role=foot]').innerHTML = `<span>${sel.length ? `${__('{sel} / {n} seçili', { sel: sel.length, n: rows.length })}${bytes ? ' · ' + fmtSize(bytes) : ''}` : __('{n} öğe', { n: rows.length })}${hid > 0 ? ' · ' + __('{n} gizli', { n: hid }) : ''}</span>
      <button class="ssh-hid${X.ui.hidden ? ' on' : ''}" data-act="toggleHidden" title="${esc(__('Nokta ile başlayan gizli dosyaları göster / gizle (Ctrl+H)'))}"><i class="fa-solid fa-eye${X.ui.hidden ? '' : '-slash'}"></i>${__('Gizli')}</button>`;
  }
  const ICONS = { js: 'fa-file-code', ts: 'fa-file-code', py: 'fa-file-code', php: 'fa-file-code', go: 'fa-file-code', rs: 'fa-file-code', java: 'fa-file-code', c: 'fa-file-code', cpp: 'fa-file-code', cs: 'fa-file-code', sh: 'fa-file-code', html: 'fa-file-code', css: 'fa-file-code', json: 'fa-file-code', yml: 'fa-file-code', yaml: 'fa-file-code', xml: 'fa-file-code', sql: 'fa-file-code', md: 'fa-file-lines', txt: 'fa-file-lines', log: 'fa-file-lines', conf: 'fa-file-lines', ini: 'fa-file-lines', env: 'fa-file-lines', png: 'fa-file-image', jpg: 'fa-file-image', jpeg: 'fa-file-image', gif: 'fa-file-image', svg: 'fa-file-image', webp: 'fa-file-image', zip: 'fa-file-zipper', gz: 'fa-file-zipper', tgz: 'fa-file-zipper', tar: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper', pdf: 'fa-file-pdf', mp4: 'fa-file-video', mp3: 'fa-file-audio' };
  const fileIcon = n => ICONS[(n.split('.').pop() || '').toLowerCase()] || 'fa-file';
  const fullPath = (t, side, name) => (side === 'remote' ? rjoin(t.remote.path, name) : ljoin(t.local.path, name));
  const selected = (t, side) => { const p = P(t, side); return (p.view || []).filter(f => p.sel.has(f.name)); };
  function selOrFocus(t, side) {
    const s = selected(t, side); if (s.length) return s;
    const p = P(t, side), f = (p.view || [])[p.focus]; return f ? [f] : [];
  }
  function openItem(t, side, f) {
    if (!f) return;
    if (f.dir) { loadPane(t, side, f.drive ? f.name : fullPath(t, side, f.name)); return; }
    if (side === 'local') { inv('ssh:localOp', 'open', { path: fullPath(t, side, f.name) }).then(r => { if (r.error) toast(__('Açılamadı'), r.error); }); return; }
    editRemote(t, fullPath(t, side, f.name));
  }
  function goUp(t, side) {
    const p = P(t, side);
    if (side === 'remote') { if (p.path !== '/') loadPane(t, side, rparent(p.path)); }
    else if (p.path) loadPane(t, side, lparent(p.path));
  }
  function goBack(t, side) {
    const h = t.hist[side]; if (!h.length) return;
    loadPane(t, side, h.pop(), false, true);
  }
  function selectRow(t, side, i, e) {
    const p = P(t, side), rows = p.view || [], f = rows[i]; if (!f) return;
    if (e && e.shiftKey && p.anchor >= 0) {
      if (!modKey(e)) p.sel.clear();
      const [a, b] = [Math.min(p.anchor, i), Math.max(p.anchor, i)];
      for (let k = a; k <= b; k++) p.sel.add(rows[k].name);
    } else if (e && modKey(e)) {
      if (p.sel.has(f.name)) p.sel.delete(f.name); else p.sel.add(f.name);
      p.anchor = i;
    } else { p.sel = new Set([f.name]); p.anchor = i; }
    p.focus = i;
    renderPane(t, side);
  }
  function moveFocus(t, side, d, e) {
    const p = P(t, side), n = (p.view || []).length; if (!n) return;
    const i = Math.max(0, Math.min(n - 1, (p.focus < 0 ? 0 : p.focus) + d));
    if (e.shiftKey) { if (p.anchor < 0) p.anchor = p.focus; selectRow(t, side, i, { shiftKey: true }); }
    else selectRow(t, side, i, null);
    const row = paneEl(t, side).querySelector(`.ssh-row[data-i="${i}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- file operations ---------------- */
  async function mkdir(t, side) {
    const r = await modal({ title: __('Yeni klasör'), icon: 'fa-folder-plus', body: `<label class="db-f"><span>${__('Ad')}</span><input name="n" spellcheck="false"></label>`, buttons: [['cancel', __('Vazgeç')], ['ok', __('Oluştur'), 'primary']] });
    const n = r && r.value === 'ok' && r.form.n.trim(); if (!n) return;
    const res = side === 'remote' ? await inv('ssh:op', t.sid, 'mkdir', { path: fullPath(t, side, n) }) : await inv('ssh:localOp', 'mkdir', { path: fullPath(t, side, n) });
    if (res.error) { toast(__('Klasör oluşturulamadı'), res.error); return; }
    P(t, side).sel = new Set([n]);
    loadPane(t, side, P(t, side).path, true);
  }
  async function touch(t) {
    const r = await modal({ title: __('Yeni dosya'), icon: 'fa-file-circle-plus', body: `<label class="db-f"><span>${__('Ad')}</span><input name="n" spellcheck="false"></label>`, buttons: [['cancel', __('Vazgeç')], ['ok', __('Oluştur ve düzenle'), 'primary']] });
    const n = r && r.value === 'ok' && r.form.n.trim(); if (!n) return;
    const fp = fullPath(t, 'remote', n);
    const res = await inv('ssh:op', t.sid, 'touch', { path: fp });
    if (res.error) { toast(__('Dosya oluşturulamadı'), res.error); return; }
    t.remote.sel = new Set([n]);
    await loadPane(t, 'remote', t.remote.path, true);
    editRemote(t, fp);
  }
  async function rename(t, side) {
    const f = selOrFocus(t, side)[0]; if (!f || f.drive) return;
    const r = await modal({
      title: __('Yeniden adlandır'), icon: 'fa-i-cursor', body: `<label class="db-f"><span>${__('Yeni ad')}</span><input name="n" value="${esc(f.name)}" spellcheck="false"></label>`,
      buttons: [['cancel', __('Vazgeç')], ['ok', __('Adlandır'), 'primary']],
      onOpen: form => requestAnimationFrame(() => { const i = form.querySelector('input'); const dot = f.dir ? -1 : f.name.lastIndexOf('.'); i.setSelectionRange(0, dot > 0 ? dot : f.name.length); }),
    });
    const n = r && r.value === 'ok' && r.form.n.trim(); if (!n || n === f.name) return;
    const a = { from: fullPath(t, side, f.name), to: n.includes('/') && side === 'remote' ? n : fullPath(t, side, n) };
    const res = side === 'remote' ? await inv('ssh:op', t.sid, 'rename', a) : await inv('ssh:localOp', 'rename', a);
    if (res.error) { toast(__('Adlandırılamadı'), res.error); return; }
    P(t, side).sel = new Set([n]);
    loadPane(t, side, P(t, side).path, true);
  }
  async function remove(t, side) {
    const items = selOrFocus(t, side).filter(f => !f.drive); if (!items.length) return;
    const remote = side === 'remote';
    const one = items.length === 1, name = one ? esc(items[0].name) : '', n = items.length;
    const kind = one ? (items[0].dir ? 'dir' : 'file') : (items.some(f => f.dir) ? 'manyDirs' : 'many');
    const msg = remote ? {
      dir: __('<b>{name}</b> klasörü ve içindeki her şey sunucudan <b>kalıcı olarak</b> silinecek. Bu işlem geri alınamaz.', { name }),
      file: __('<b>{name}</b> sunucudan <b>kalıcı olarak</b> silinecek. Bu işlem geri alınamaz.', { name }),
      manyDirs: __('<b>{n} öğe</b> (klasörlerin içeriğiyle birlikte) sunucudan <b>kalıcı olarak</b> silinecek. Bu işlem geri alınamaz.', { n }),
      many: __('<b>{n} öğe</b> sunucudan <b>kalıcı olarak</b> silinecek. Bu işlem geri alınamaz.', { n }),
    }[kind] : {
      dir: __('<b>{name}</b> klasörü ve içindeki her şey Geri Dönüşüm Kutusu’na taşınacak.', { name }),
      file: __('<b>{name}</b> Geri Dönüşüm Kutusu’na taşınacak.', { name }),
      manyDirs: __('<b>{n} öğe</b> (klasörlerin içeriğiyle birlikte) Geri Dönüşüm Kutusu’na taşınacak.', { n }),
      many: __('<b>{n} öğe</b> Geri Dönüşüm Kutusu’na taşınacak.', { n }),
    }[kind];
    const r = await modal({
      title: remote ? __('Sunucudan sil') : __('Geri Dönüşüm Kutusu’na taşı'), icon: 'fa-trash-can', danger: remote,
      body: `<p>${msg}</p>`,
      buttons: [['cancel', __('Vazgeç')], ['ok', remote ? __('Kalıcı olarak sil') : __('Taşı'), remote ? 'danger' : 'primary']], focus: 'cancel',
    });
    if (!r || r.value !== 'ok') return;
    const paths = items.map(f => fullPath(t, side, f.name));
    const res = remote ? await inv('ssh:op', t.sid, 'delete', { paths }) : await inv('ssh:localOp', 'trash', { paths });
    if (res.error) toast(__('Silinemedi'), res.error);
    P(t, side).sel.clear();
    loadPane(t, side, P(t, side).path);
  }
  async function chmod(t) {
    const items = selOrFocus(t, 'remote'); if (!items.length) return;
    const m0 = items[0].mode || 0o644;
    const bits = [[__('Sahip'), 6], [__('Grup'), 3], [__('Diğer'), 0]];
    const body = `<p>${items.length === 1 ? `<b>${esc(items[0].name)}</b>` : `<b>${__('{n} öğe', { n: items.length })}</b>`}</p>
      <table class="ssh-perm"><tr><th></th><th>${__('Okuma')}</th><th>${__('Yazma')}</th><th>${__('Çalıştırma')}</th></tr>
      ${bits.map(([l, s]) => `<tr><td>${l}</td>${[4, 2, 1].map(b => `<td><input type="checkbox" data-bit="${b << s}"${m0 & (b << s) ? ' checked' : ''}></td>`).join('')}</tr>`).join('')}</table>
      <label class="db-f"><span>${__('Sekizlik (octal)')}</span><input name="oct" value="${(m0 & 0o777).toString(8).padStart(3, '0')}" maxlength="4" inputmode="numeric" spellcheck="false"></label>`;
    const r = await modal({
      title: __('İzinler (chmod)'), icon: 'fa-lock', body, buttons: [['cancel', __('Vazgeç')], ['ok', __('Uygula'), 'primary']],
      onOpen: form => {
        const oct = form.querySelector('[name=oct]');
        form.addEventListener('change', e => { if (e.target.dataset.bit) { let m = 0; form.querySelectorAll('[data-bit]').forEach(c => { if (c.checked) m |= +c.dataset.bit; }); oct.value = m.toString(8).padStart(3, '0'); } });
        oct.addEventListener('input', () => { const m = parseInt(oct.value, 8); if (!isNaN(m)) form.querySelectorAll('[data-bit]').forEach(c => { c.checked = !!(m & +c.dataset.bit); }); });
      },
    });
    if (!r || r.value !== 'ok') return;
    const mode = parseInt(r.form.oct, 8);
    if (isNaN(mode) || mode < 0 || mode > 0o7777) { toast(__('Geçersiz izin değeri'), r.form.oct); return; }
    for (const f of items) { const res = await inv('ssh:op', t.sid, 'chmod', { path: fullPath(t, 'remote', f.name), mode }); if (res.error) { toast(__('İzin değiştirilemedi'), res.error); break; } }
    loadPane(t, 'remote', t.remote.path, true);
  }
  async function calcSize(t) {
    const items = selOrFocus(t, 'remote'); if (!items.length) return;
    toast(__('Boyut hesaplanıyor…'), items.length === 1 ? items[0].name : __('{n} öğe', { n: items.length }));
    const r = await inv('ssh:op', t.sid, 'du', { paths: items.map(f => fullPath(t, 'remote', f.name)) });
    if (r.error) toast(__('Hesaplanamadı'), r.error);
    else toast(__('Toplam boyut: {size}', { size: fmtSize(r.total) }), __('{files} dosya, {dirs} klasör', { files: r.files.toLocaleString(I18N.locale()), dirs: r.dirs.toLocaleString(I18N.locale()) }));
  }
  function cdTerminal(t, dir) {
    if (!t.ch) { toast(__('Terminal kapalı'), __('Terminalde Enter’a basarak yeni kabuk aç.')); return; }
    if (t.view === 'files') setView(t, 'split');
    api.send('ssh:write', t.ch, `cd ${shq(dir)}\r`);
    t.term.focus();
  }

  /* ---------------- transfers ---------------- */
  async function transfer(t, dir, paths, target) {
    if (!t.sid) { toast(__('Bağlantı kapalı'), __('Önce yeniden bağlan.')); return; }
    if (!paths.length) return;
    if (dir === 'down' && !target) { toast(__('Hedef klasör yok'), __('Sol panelde bir klasör aç.')); return; }
    const r = await inv('ssh:transfer', t.sid, dir, paths, target);
    if (r.error) toast(__('Aktarım başlatılamadı'), r.error);
  }
  function upload(t) {
    const items = selOrFocus(t, 'local').filter(f => !f.drive);
    transfer(t, 'up', items.map(f => fullPath(t, 'local', f.name)), t.remote.path);
  }
  function download(t) {
    const items = selOrFocus(t, 'remote');
    transfer(t, 'down', items.map(f => fullPath(t, 'remote', f.name)), t.local.path);
  }
  function renderXfers(t) {
    const el = t.el.querySelector('[data-role=xfers]');
    const list = [...X.xfers.values()].filter(j => j.sid === t.sid || j.tab === t.id);
    el.hidden = !list.length;
    if (!list.length) { el.innerHTML = ''; return; }
    const active = list.filter(j => !['done', 'error', 'canceled'].includes(j.state)).length;
    el.innerHTML = `<div class="ssh-xh"><b>${__('Aktarımlar')}</b><span>${active ? __('{n} süren', { n: active }) : __('tamamlandı')}</span><span class="ssh-grow"></span><button class="ssh-tb" data-act="clearXfers" title="${esc(__('Bitenleri listeden kaldır'))}"><i class="fa-solid fa-broom"></i>${__('Temizle')}</button></div>
      <div class="ssh-xl">${list.slice().reverse().map(j => {
        const pct = j.total ? Math.min(100, Math.round(j.done * 100 / j.total)) : (j.state === 'done' ? 100 : 0);
        const st = { preparing: __('Hazırlanıyor…'), running: `${fmtSize(j.done)} / ${fmtSize(j.total)}${j.speed ? ' · ' + __('{size}/sn', { size: fmtSize(j.speed) }) : ''}`, ask: __('Yanıt bekleniyor…'), done: `${__('Tamam · {size}', { size: fmtSize(j.total) })}${j.skipped ? ' · ' + __('{n} atlandı', { n: j.skipped }) : ''}`, error: j.error || __('Hata'), canceled: __('İptal edildi') }[j.state] || '';
        return `<div class="ssh-x ${j.state}" title="${esc(j.current || j.target)}">
          <i class="fa-solid ${j.dir === 'up' ? 'fa-arrow-up' : 'fa-arrow-down'} ssh-xd"></i>
          <span class="ssh-xn">${esc(j.name)}${j.files > 1 ? ` <small>${__('{done}/{n} dosya', { done: j.filesDone, n: j.files })}</small>` : ''}</span>
          <span class="ssh-xb"><i style="width:${pct}%"></i></span>
          <span class="ssh-xs">${esc(st)}</span>
          ${['done', 'error', 'canceled'].includes(j.state) ? (j.dir === 'down' && j.state === 'done' ? `<button class="ssh-ib sm" data-xreveal="${j.id}" title="${esc(__('Klasörde göster'))}" aria-label="${esc(__('Klasörde göster'))}"><i class="fa-regular fa-folder-open"></i></button>` : '<span class="ssh-ib sm"></span>') : `<button class="ssh-ib sm" data-xcancel="${j.id}" title="${esc(__('İptal'))}" aria-label="${esc(__('İptal'))}"><i class="fa-solid fa-xmark"></i></button>`}
        </div>`;
      }).join('')}</div>`;
  }
  function onXfer(j) {
    const prev = X.xfers.get(j.id);
    X.xfers.set(j.id, Object.assign(prev || {}, j));
    const t = tabBySid(j.sid);
    if (!t) return;
    renderXfers(t);
    if (['done', 'error', 'canceled'].includes(j.state) && (!prev || prev.state !== j.state)) {
      if (j.dir === 'up') { if (t.remote.path === j.target || j.target.startsWith(rjoin(t.remote.path, ''))) loadPane(t, 'remote', t.remote.path, true); }
      else if (t.local.path === j.target) loadPane(t, 'local', t.local.path, true);
      if (j.state === 'error') toast(__('Aktarım başarısız: {name}', { name: j.name }), j.error);
      else if (j.state === 'done' && (j.files > 1 || j.total > 20 * 1048576)) toast(j.dir === 'up' ? __('Yükleme bitti') : __('İndirme bitti'),`${j.name} · ${fmtSize(j.total)}`);
    }
  }
  async function onXferAsk(a) {
    const fmt = x => `${fmtSize(x.size)} · ${fmtDate(x.mtime)}`;
    const r = await modal({
      title: __('Dosya zaten var'), icon: 'fa-copy', wide: true,
      body: `<p class="ssh-mono">${esc(a.file)}</p>
        <div class="ssh-cmp"><span>${__('Kaynak')}</span><b>${esc(fmt(a.src))}</b><span>${__('Hedef')}</span><b>${esc(fmt(a.dst))}</b></div>
        <p class="db-muted">${__('“Tümü” seçenekleri bu aktarımdaki diğer çakışmalara da uygulanır.')}</p>`,
      buttons: [['cancel', __('Aktarımı iptal et')], ['skipAll', __('Tümünü atla')], ['skip', __('Atla')], ['newerAll', __('Yeniyse üzerine yaz (tümü)')], ['overwriteAll', __('Tümünün üzerine yaz')], ['overwrite', __('Üzerine yaz'), 'primary']],
    });
    inv('ssh:xferAnswer', a.id, r ? r.value : 'cancel');
  }

  /* ---------------- remote editor ---------------- */
  async function editRemote(t, fp) {
    const r = await inv('ssh:op', t.sid, 'read', { path: fp });
    if (r.error) {
      if (r.binary || r.tooBig) {
        const a = await modal({ title: __('Düzenleyicide açılamıyor'), icon: 'fa-file', body: `<p>${esc(r.error)}</p><p>${__('Dosyayı soldaki klasöre (<b>{path}</b>) indirmek ister misin?', { path: esc(t.local.path || '—') })}</p>`, buttons: [['cancel', __('Vazgeç')], ['ok', __('İndir'), 'primary']] });
        if (a && a.value === 'ok') transfer(t, 'down', [fp], t.local.path);
      } else toast(__('Açılamadı'), r.error);
      return;
    }
    let mtime = r.mtime, ed = null, dirty = false;
    const name = fp.split('/').pop();
    const save = async (force) => {
      let text = ed.getValue();
      if (r.crlf) text = text.replace(/\r?\n/g, '\r\n');
      const w = await inv('ssh:op', t.sid, 'write', { path: fp, text, mtime, force });
      if (w.conflict) {
        const c = await confirmBox(__('Dosya sunucuda değişmiş'), __('Sen düzenlerken dosya sunucuda başka biri ya da bir program tarafından değiştirildi. Yine de kendi sürümünle üzerine yazılsın mı?'), __('Üzerine yaz'), true);
        if (c) return save(true);
        return false;
      }
      if (w.error) { toast(__('Kaydedilemedi'), w.error); return false; }
      mtime = w.mtime; dirty = false; setTitle();
      toast(__('Kaydedildi'), fp);
      if (t.remote.path === rparent(fp)) loadPane(t, 'remote', t.remote.path, true);
      return true;
    };
    const setTitle = () => { const b = document.querySelector('#sshModal .db-dh b'); if (b) b.textContent = (dirty ? '● ' : '') + name; };
    await modal({
      title: name, icon: 'fa-pen-to-square', wide: true, cls: 'ssh-editor',
      body: `<div class="ssh-epath ssh-mono">${esc(hostAddr(host(t.hostId)))}:${esc(fp)}</div><div class="ssh-ed" data-role="ed"></div>`,
      buttons: [['cancel', __('Kapat')], ['save', __('Kaydet (Ctrl+S)'), 'primary']],
      onOpen: form => {
        const mode = (typeof MODES !== 'undefined' && typeof extOf === 'function') ? MODES[extOf(fp)] || null : null;
        ed = CodeMirror(form.querySelector('[data-role=ed]'), {
          value: r.text.replace(/\r\n/g, '\n'), mode, theme: 'claudelot', lineNumbers: true, matchBrackets: true, styleActiveLine: true, indentUnit: 2, tabSize: 4,
          extraKeys: cmKeys({ 'Ctrl-S': () => { save(); }, Tab: c => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ')) }),
        });
        ed.on('change', () => { if (!dirty) { dirty = true; setTitle(); } });
        requestAnimationFrame(() => { ed.refresh(); ed.focus(); });
      },
      onAction: async v => {
        if (v === 'save') { await save(); return true; }
        return false;
      },
      beforeClose: async () => {
        if (!dirty) return true;
        const keep = await confirmInline(__('Kaydedilmemiş değişiklikler var. Kaydetmeden kapatılsın mı?'));
        return keep;
      },
    });
  }
  // a small confirm that shows over the editor without closing it
  function confirmInline(msg) {
    return new Promise(res => {
      const host = document.querySelector('#sshModal .db-dlg'); if (!host) { res(true); return; }
      const bar = document.createElement('div');
      bar.className = 'ssh-confirm';
      bar.innerHTML = `<span>${esc(msg)}</span><button type="button" class="btn" data-cf="no">${__('Vazgeç')}</button><button type="button" class="btn db-bdanger" data-cf="yes">${__('Kaydetmeden kapat')}</button>`;
      host.appendChild(bar);
      bar.querySelector('[data-cf=no]').focus();
      bar.addEventListener('click', e => { const b = e.target.closest("[data-cf]"); if (!b) return; e.preventDefault(); e.stopPropagation(); bar.remove(); res(b.dataset.cf === "yes"); });
    });
  }

  /* ---------------- modal dialogs (same look as DB mode) ---------------- */
  let modalDone = null;
  function modal({ title, body, buttons, icon, danger, wide, cls, focus, onOpen, onAction, beforeClose }) {
    const el = document.getElementById('sshModal');
    if (modalDone) modalDone(null, true);
    return new Promise(resolve => {
      el.innerHTML = `<form class="db-dlg${wide ? ' wide' : ''}${danger ? ' danger' : ''}${cls ? ' ' + cls : ''}" novalidate role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="db-dh">${icon ? `<i class="fa-solid ${icon}"></i>` : ''}<b>${esc(title)}</b><button type="button" class="db-ib" data-mb="cancel" aria-label="${esc(__('Kapat'))}"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="db-db">${body}</div>
        <div class="db-df">${(buttons || []).map(([v, l, k]) => `<button type="${k === 'primary' || k === 'danger' ? 'submit' : 'button'}" class="btn ${k === 'danger' ? 'db-bdanger' : k || ''}" data-mb="${v}">${esc(l)}</button>`).join('')}</div></form>`;
      el.hidden = false;
      const form = el.querySelector('form');
      const values = () => { const o = {}; form.querySelectorAll('[name]').forEach(x => { o[x.name] = x.type === 'checkbox' ? x.checked : x.type === 'radio' ? (x.checked ? x.value : (o[x.name] || '')) : x.value; }); return o; };
      const done = (v, forced) => { if (modalDone !== done) return; modalDone = null; el.hidden = true; el.innerHTML = ''; resolve(forced ? null : v); };
      modalDone = done;
      const finish = async v => {
        if (v === 'cancel') { if (beforeClose && !(await beforeClose())) return; done(null); return; }
        if (onAction) { const keep = await onAction(v, values(), form); if (keep) return; }
        done({ value: v, form: values() });
      };
      form.addEventListener('submit', e => { e.preventDefault(); const b = form.querySelector('.db-df [type=submit]'); finish(b ? b.dataset.mb : 'ok'); });
      form.addEventListener('click', e => { const b = e.target.closest('[data-mb]'); if (b) { e.preventDefault(); finish(b.dataset.mb); } });
      form.addEventListener('keydown', e => { if (e.key === 'Escape' && !form.querySelector('.ssh-confirm')) { e.preventDefault(); e.stopPropagation(); finish('cancel'); } });
      el.onmousedown = e => { if (e.target === el && !beforeClose) done(null); };
      if (onOpen) onOpen(form);
      requestAnimationFrame(() => {
        if (cls === 'ssh-editor') return;
        const f = focus ? form.querySelector(`.db-df [data-mb="${focus}"]`) : form.querySelector('input:not([type=checkbox]):not([type=radio]):not([readonly]),textarea,select') || form.querySelector('.db-df [type=submit]');
        if (f) { f.focus(); if (f.select && f.tagName === 'INPUT') f.select(); }
      });
    });
  }
  async function confirmBox(title, text, okLabel, danger) {
    const r = await modal({ title, icon: danger ? 'fa-triangle-exclamation' : 'fa-circle-question', danger, body: `<p>${esc(text)}</p>`, buttons: [['cancel', __('Vazgeç')], ['ok', okLabel || __('Tamam'), danger ? 'danger' : 'primary']], focus: 'cancel' });
    return !!(r && r.value === 'ok');
  }
  async function askSecret(h, what, err) {
    const pp = what === 'pp';
    const r = await modal({
      title: pp ? __('Anahtar parolası') : __('Parola gerekli'), icon: 'fa-key',
      body: `<p><b>${esc(hostLabel(h))}</b> · ${esc(hostAddr(h))}</p>${pp ? `<p class="db-muted ssh-mono">${esc(h.keyPath)}</p>` : ''}${err ? `<p class="db-errbox">${esc(err)}</p>` : ''}
        <label class="db-f"><span>${pp ? __('Anahtar parolası (passphrase)') : __('Parola')}</span><input type="password" name="pw" autocomplete="off"></label>
        ${X.canEncrypt && !h.askPassword ? `<label class="db-ck"><input type="checkbox" name="remember"><span>${pp ? __('Anahtar parolasını kaydet (Windows hesabına bağlı olarak şifrelenir)') : __('Parolayı kaydet (Windows hesabına bağlı olarak şifrelenir)')}</span></label>` : `<p class="db-muted">${__('Yalnızca bu oturum boyunca bellekte tutulur.')}</p>`}`,
      buttons: [['cancel', __('Vazgeç')], ['ok', __('Bağlan'), 'primary']],
    });
    return r && r.value === 'ok' ? { value: r.form.pw, remember: !!r.form.remember } : null;
  }
  async function askHostKey(h, r) {
    const changed = r.changed;
    const res = await modal({
      title: changed ? __('UYARI: Sunucu anahtarı değişmiş!') : __('Yeni sunucu'), icon: changed ? 'fa-shield-halved' : 'fa-fingerprint', danger: changed, wide: changed,
      body: changed
        ? `<p class="db-errbox">${__('<b>{host}</b> için daha önce kaydedilen anahtar ile şimdi gelen anahtar farklı. Sunucu yeniden kurulmuş olabilir; ama biri araya girip bağlantıyı dinliyor da olabilir (man-in-the-middle).', { host: esc(h.host) })}</p>
           <div class="ssh-cmp"><span>${__('Kayıtlı')}</span><b class="ssh-mono">${esc(r.oldKey)}</b><span>${__('Gelen')}</span><b class="ssh-mono">${esc(r.hostKey)}</b></div>
           <p>${__('Değişikliğin beklendiğinden emin değilsen sunucu yöneticisine sor ve bağlanma.')}</p>`
        : `<p>${__('<b>{addr}</b> sunucusuna ilk kez bağlanıyorsun. Sunucunun anahtar parmak izi:', { addr: esc(hostAddr(h)) })}</p><p class="ssh-fpbox ssh-mono">${esc(r.hostKey)}</p><p class="db-muted">${__('Güvenirsen kaydedilir; bir dahaki sefere sorulmaz, değişirse uyarılırsın.')}</p>`,
      buttons: [['cancel', __('Bağlanma')], ['ok', changed ? __('Yeni anahtarı kabul et') : __('Güven ve bağlan'), changed ? 'danger' : 'primary']], focus: changed ? 'cancel' : undefined,
    });
    return !!(res && res.value === 'ok');
  }

  /* ---------------- host dialog ---------------- */
  async function editHost(id, preset) {
    const c = id ? host(id) : null;
    const v = c ? { ...c } : Object.assign({ kind: 'ssh', host: '', port: '', user: '', auth: 'password', color: '', keepalive: 30, tunnels: [] }, preset || {});
    const chk = x => (x ? ' checked' : '');
    const sel = (a, b) => (a === b ? ' selected' : '');
    const tun = (v.tunnels || []).map(t => `${t.localPort} ${t.remoteHost}:${t.remotePort}`).join('\n');
    const groups = [...new Set(X.hosts.map(h => h.group).filter(Boolean))];
    const body = `
      <div class="db-grid2">
        <div class="db-f full"><span>${__('Tür')}</span><div class="db-typesel"><label><input type="radio" name="kind" value="ssh"${chk(v.kind !== 'rdp')}><span><i class="fa-solid fa-terminal"></i> SSH / SFTP</span></label><label><input type="radio" name="kind" value="rdp"${chk(v.kind === 'rdp')}><span><i class="fa-solid fa-desktop"></i> ${__('Uzak Masaüstü (RDP)')}</span></label></div></div>
        <label class="db-f wide"><span>${__('Ad')}</span><input name="name" value="${esc(v.name || '')}" placeholder="${esc(__('Örn. Üretim web sunucusu'))}" maxlength="80"></label>
        <label class="db-f"><span>${__('Grup')}</span><input name="group" value="${esc(v.group || '')}" list="sshGroups" placeholder="${esc(__('İsteğe bağlı'))}" maxlength="60"><datalist id="sshGroups">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist></label>
        <label class="db-f wide"><span>${__('Sunucu')}</span><input name="host" value="${esc(v.host || '')}" placeholder="${esc(__('ornek.com ya da 10.0.0.5'))}" spellcheck="false"></label>
        <label class="db-f"><span>${__('Port')}</span><input name="port" value="${esc(v.port || '')}" inputmode="numeric" placeholder="${v.kind === 'rdp' ? 3389 : 22}"></label>
        <label class="db-f rdp-only"><span>${__('Alan (domain)')}</span><input name="domain" value="${esc(v.domain || '')}" spellcheck="false" placeholder="${esc(__('İsteğe bağlı'))}"></label>
        <label class="db-f"><span>${__('Kullanıcı')}</span><input name="user" value="${esc(v.user || '')}" spellcheck="false" autocomplete="off" placeholder="${v.kind === 'rdp' ? '' : 'root'}"></label>
        <label class="db-f ssh-only"><span>${__('Kimlik doğrulama')}</span><select name="auth"><option value="password"${sel(v.auth, 'password')}>${__('Parola')}</option><option value="key"${sel(v.auth, 'key')}>${__('Özel anahtar dosyası')}</option><option value="agent"${sel(v.auth, 'agent')}>${__('SSH ajanı / Pageant')}</option></select></label>
        <div class="db-f full key-only"><span>${__('Özel anahtar (OpenSSH ya da PuTTY .ppk)')}</span><div class="ssh-keyrow"><input name="keyPath" value="${esc(v.keyPath || '')}" placeholder="C:\\Users\\…\\.ssh\\id_ed25519" spellcheck="false"><button type="button" class="btn" data-mb="pickKey">${__('Seç…')}</button></div></div>
        <label class="db-f full pw-only"><span class="pw-l">${__('Parola')}</span><input type="password" name="pw" autocomplete="new-password" placeholder="${c && c.hasPassword ? esc(__('Kayıtlı parola değişmez')) : ''}"></label>
        <label class="db-f full key-only"><span>${__('Anahtar parolası (passphrase)')}</span><input type="password" name="pp" autocomplete="new-password" placeholder="${esc(c && c.hasPassphrase ? __('Kayıtlı parola değişmez') : __('Anahtar şifreliyse'))}"></label>
        <div class="db-f full db-row pwk-only">
          <label class="db-ck"><input type="checkbox" name="askPassword"${chk(v.askPassword)}><span>${__('Parolayı kaydetme, her bağlanışta sor')}</span></label>
          ${c && (c.hasPassword || c.hasPassphrase) ? `<button type="button" class="db-link" data-mb="clearPw">${__('Kayıtlı parolayı sil')}</button>` : ''}
        </div>
        ${!X.canEncrypt ? `<p class="db-note warn full"><i class="fa-solid fa-triangle-exclamation"></i>${__('Bu bilgisayarda şifreleme kullanılamıyor; parolalar yalnızca oturum boyunca bellekte tutulur.')}</p>` : ''}
        <label class="db-f wide ssh-only"><span>${__('Açılış klasörü (sunucu)')}</span><input name="startDir" value="${esc(v.startDir || '')}" placeholder="${esc(__('Ev klasörü'))}" spellcheck="false"></label>
        <label class="db-f ssh-only"><span>${__('Canlı tutma (sn)')}</span><input name="keepalive" value="${esc(v.keepalive == null ? 30 : v.keepalive)}" inputmode="numeric" title="${esc(__('0: kapalı'))}"></label>
        <label class="db-f full ssh-only"><span>${__('Yerel klasör (bu bilgisayar)')}</span><input name="localDir" value="${esc(v.localDir || '')}" placeholder="${esc(__('Son kullanılan klasör'))}" spellcheck="false"></label>
        <label class="db-f full ssh-only"><span>${__('Tüneller (yerel port yönlendirme) · her satır: <code>yerelPort hedef:port</code>')}</span><textarea name="tunnels" rows="2" spellcheck="false" placeholder="3307 127.0.0.1:3306">${esc(tun)}</textarea></label>
        <label class="db-ck full ssh-only"><input type="checkbox" name="tunAuto"${chk((v.tunnels || []).some(t => t.auto))}><span>${__('Bağlanınca tünelleri otomatik aç (örn. DB modunda <code>localhost:3307</code> ile bağlan)')}</span></label>
        <label class="db-f full ssh-only"><span>${__('Claude / Codex erişimi · bağlantıyı VoxStorm kurar, adres ve parola ajana verilmez')}</span><select name="aiAccess"><option value=""${sel(v.aiAccess || '', '')}>${__('Her oturumda ilk kullanımda sor')}</option><option value="allow"${sel(v.aiAccess, 'allow')}>${__('Her zaman izin ver')}</option><option value="deny"${sel(v.aiAccess, 'deny')}>${__('Asla izin verme (ajanlar bu bağlantıyı görmez)')}</option></select></label>
        <label class="db-ck full rdp-only"><input type="checkbox" name="fullscreen"${chk(v.fullscreen)}><span>${__('Tam ekran aç')}</span></label>
        <label class="db-ck full rdp-only"><input type="checkbox" name="admin"${chk(v.admin)}><span>${__('Yönetici oturumu (/admin)')}</span></label>
        <div class="db-f full"><span>${__('Renk')}</span><div class="db-colors">${COLORS.map(([k, l]) => `<label title="${esc(l)}"><input type="radio" name="color" value="${k}"${chk((v.color || '') === k)}><span class="db-sw db-c-${k || 'none'}"></span></label>`).join('')}</div></div>
        <p class="db-note full rdp-only"><i class="fa-solid fa-circle-info"></i>${IS_MAC
          ? __('RDP bağlantısı Windows App (Microsoft Remote Desktop) ile açılır; App Store’dan kurulu olmalı. Parolayı orada girersin.')
          : __('RDP bağlantısı Windows Uzak Masaüstü (mstsc) penceresinde açılır. Parola girersen Windows Kimlik Bilgileri Yöneticisi’ne kaydedilir.')}</p>
      </div>`;
    const parseTunnels = (txt, auto) => String(txt || '').split(/\n/).map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.match(/^(?:L\s+)?(\d+)\s*[\s:>-]+\s*([^\s:]+):(\d+)$/i);
      return m ? { localPort: +m[1], remoteHost: m[2], remotePort: +m[3], auto } : { bad: l };
    });
    const r = await modal({
      title: c ? __('Bağlantıyı düzenle') : __('Yeni bağlantı'), icon: 'fa-server', wide: true,
      body, buttons: [['cancel', __('Vazgeç')], ['save', __('Kaydet'), 'primary']],
      onOpen: form => {
        const sync = () => {
          const kind = form.querySelector('[name=kind]:checked').value, auth = form.querySelector('[name=auth]').value;
          form.classList.toggle('k-rdp', kind === 'rdp');
          form.classList.toggle('a-key', kind === 'ssh' && auth === 'key');
          form.classList.toggle('a-pw', kind === 'rdp' || auth === 'password');
          form.classList.toggle('a-agent', kind === 'ssh' && auth === 'agent');
          form.querySelector('[name=port]').placeholder = kind === 'rdp' ? '3389' : '22';
        };
        form.addEventListener('change', sync); sync();
      },
      onAction: async (act, f, form) => {
        if (act === 'pickKey') { const p = await inv('ssh:pickKey'); if (p && typeof p === 'string') form.querySelector('[name=keyPath]').value = p; return true; }
        if (act === 'clearPw') { await inv('ssh:save', { ...v, id: c.id, clearPw: true }); await loadHosts(); toast(__('Kayıtlı parola silindi')); form.querySelector('[data-mb=clearPw]').remove(); return true; }
        if (!f.host.trim()) { form.querySelector('[name=host]').focus(); toast(__('Sunucu adresi gerekli')); return true; }
        const tunnels = parseTunnels(f.tunnels, !!f.tunAuto);
        const bad = tunnels.find(x => x.bad);
        if (bad && f.kind === 'ssh') { toast(__('Tünel satırı anlaşılamadı'), __('{line} — örnek: 3307 127.0.0.1:3306', { line: bad.bad })); return true; }
        f.tunnels = tunnels;
        if (f.kind === 'ssh' && f.auth === 'key' && !f.keyPath.trim()) { toast(__('Anahtar dosyası seç')); return true; }
        const saved = await inv('ssh:save', { ...f, id: c ? c.id : undefined, pw: f.pw || undefined, pp: f.pp || undefined });
        if (saved.error) { toast(__('Kaydedilemedi'), saved.error); return true; }
        v.savedId = saved.id;
        return false;
      },
    });
    if (!r || r.value !== 'save') return null;
    await loadHosts();
    X.cur = v.savedId || X.cur;
    renderHosts();
    X.tabs.forEach(t => { if (t.hostId === v.savedId) { renderBar(t); } });
    return v.savedId;
  }
  async function deleteHost(id) {
    const h = host(id); if (!h) return;
    if (!(await confirmBox(__('Bağlantıyı sil'), __('“{name}” kaydı ve kayıtlı parolası silinecek. Açık oturumlar etkilenmez.', { name: hostLabel(h) }), __('Sil'), true))) return;
    await inv('ssh:delete', id);
    await loadHosts(); renderHosts();
  }
  async function openRdp(h, pw) {
    const r = await inv('ssh:rdp', h.id, pw);
    if (r.error) toast(__('Uzak Masaüstü açılamadı'), r.error);
    else toast(__('Uzak Masaüstü açılıyor'), hostAddr(h));
  }
  async function pickHost() {
    if (!X.hosts.length) { const id = await editHost(); if (id) openSession(id); return; }
    const ssh = X.hosts.filter(h => h.kind !== 'rdp');
    const r = await modal({
      title: __('Yeni oturum'), icon: 'fa-network-wired',
      body: `<div class="ssh-pick">${X.hosts.map(h => `<button type="button" class="ssh-pk db-c-${h.color || 'none'}" data-mb="h:${h.id}"><i class="fa-solid ${h.kind === 'rdp' ? 'fa-desktop' : 'fa-terminal'}"></i><span><b>${esc(hostLabel(h))}</b><small>${esc(hostAddr(h))}</small></span></button>`).join('')}</div>`,
      buttons: [['cancel', __('Vazgeç')], ['new', __('Yeni bağlantı…')]],
    });
    if (!r) return;
    if (r.value === 'new') { const id = await editHost(); if (id) openSession(id); return; }
    if (r.value.startsWith('h:')) openSession(r.value.slice(2));
    void ssh;
  }

  /* ---------------- tunnels dialog ---------------- */
  async function tunnelsDialog(t) {
    if (!t.sid) { toast(__('Bağlantı kapalı')); return; }
    const h = host(t.hostId);
    const list = () => t.tunnels.length ? t.tunnels.map(x => `<div class="ssh-tun"><i class="fa-solid fa-route"></i><span class="ssh-mono">localhost:${x.localPort} → ${esc(x.remoteHost)}:${x.remotePort}</span><small${x.error ? ' class="bad"' : ''}>${x.error ? esc(x.error) : x.conns ? __('{n} bağlantı', { n: x.conns }) : ''}</small><button type="button" class="db-ib" data-mb="close:${x.localPort}" title="${esc(__('Kapat'))}" aria-label="${esc(__('Tüneli kapat'))}"><i class="fa-solid fa-xmark"></i></button></div>`).join('') : `<p class="db-muted">${__('Açık tünel yok.')}</p>`;
    const saved = (h && h.tunnels || []).filter(s => !t.tunnels.some(x => x.localPort === s.localPort));
    await modal({
      title: __('Tüneller'), icon: 'fa-route', wide: true,
      body: `<p class="db-muted">${__('Bu bilgisayardaki bir portu SSH üzerinden sunucunun erişebildiği bir adrese yönlendirir. Örn. <code>3307 → 127.0.0.1:3306</code> açıp DB modunda <code>localhost:3307</code> ile sunucudaki MySQL’e bağlanabilirsin.')}</p>
        <div class="ssh-tuns" data-role="tl">${list()}</div>
        ${saved.length ? `<div class="db-presets">${saved.map(s => `<button type="button" class="db-chipbtn" data-mb="open:${s.localPort}:${esc(s.remoteHost)}:${s.remotePort}">${s.localPort} → ${esc(s.remoteHost)}:${s.remotePort}</button>`).join('')}</div>` : ''}
        <div class="ssh-tunadd"><label class="db-f"><span>${__('Yerel port')}</span><input name="lp" inputmode="numeric" placeholder="3307"></label><label class="db-f"><span>${__('Hedef adres')}</span><input name="rh" value="127.0.0.1" spellcheck="false"></label><label class="db-f"><span>${__('Hedef port')}</span><input name="rp" inputmode="numeric" placeholder="3306"></label><button type="button" class="btn primary" data-mb="add">${__('Aç')}</button></div>`,
      buttons: [['cancel', __('Kapat')]],
      onAction: async (act, f, form) => {
        let r;
        if (act === 'add') r = await inv('ssh:tunnel', t.sid, 'open', { localPort: f.lp, remoteHost: f.rh, remotePort: f.rp });
        else if (act.startsWith('open:')) { const [, lp, rh, rp] = act.split(':'); r = await inv('ssh:tunnel', t.sid, 'open', { localPort: lp, remoteHost: rh, remotePort: rp }); }
        else if (act.startsWith('close:')) r = await inv('ssh:tunnel', t.sid, 'close', { localPort: +act.slice(6) });
        if (r && r.error) toast(__('Tünel açılamadı'), r.error);
        if (r && r.tunnels) { t.tunnels = r.tunnels; renderBar(t); form.querySelector('[data-role=tl]').innerHTML = list(); }
        return true;
      },
    });
  }

  /* ---------------- context menu ---------------- */
  function ctxMenu(x, y, items) {
    const m = document.getElementById('sshCtx');
    m.innerHTML = items.map(it => it === '-' ? '<div class="db-sep"></div>' : `<button data-ctx="${it[0]}"${it[3] ? ' disabled' : ''}><i class="fa-solid ${it[2] || ''}"></i><span>${esc(it[1])}</span>${it[4] ? `<kbd>${esc(it[4])}</kbd>` : ''}</button>`).join('');
    m.hidden = false;
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.min(x, innerWidth - w - 6) + 'px';
    m.style.top = Math.min(y, innerHeight - h - 6) + 'px';
    return new Promise(res => { m._res = res; });
  }
  function closeCtx(v) { const m = document.getElementById('sshCtx'); if (!m || m.hidden) return; m.hidden = true; if (m._res) { const r = m._res; m._res = null; r(v || null); } }
  async function paneCtx(t, side, e, onRow) {
    const remote = side === 'remote';
    const items = onRow ? selOrFocus(t, side) : [];
    const one = items.length === 1 ? items[0] : null;
    const menu = onRow ? [
      ['open', one && one.dir ? __('Aç') : remote ? __('Düzenle') : __('Aç'), one && one.dir ? 'fa-folder-open' : remote ? 'fa-pen-to-square' : 'fa-up-right-from-square', !one, 'Enter'],
      remote ? ['xfer', __('İndir (bu bilgisayara)'), 'fa-arrow-left', !t.local.path, 'F5'] : ['xfer', __('Yükle (sunucuya)'), 'fa-arrow-right', !t.sid || items.some(f => f.drive), 'F5'],
      '-',
      ['rename', __('Yeniden adlandır'), 'fa-i-cursor', !one || one.drive, 'F2'],
      ['delete', remote ? __('Sil') : __('Geri Dönüşüm Kutusu’na taşı'), 'fa-trash-can', items.some(f => f.drive), 'Del'],
      ...(remote ? [['chmod', __('İzinler (chmod)…'), 'fa-lock'], ['du', __('Boyutu hesapla'), 'fa-calculator']] : [['reveal', __('Explorer’da göster'), 'fa-folder-tree', !one || one.drive]]),
      '-',
      ['copyPath', __('Yolu kopyala'), 'fa-copy'],
      ...(remote ? [['cd', __('Terminalde bu klasöre git'), 'fa-terminal', !(one && one.dir)]] : []),
    ] : [
      ['mkdir', __('Yeni klasör'), 'fa-folder-plus', remote ? !t.sid : !P(t, side).path, 'F7'],
      ...(remote ? [['touch', __('Yeni dosya'), 'fa-file-circle-plus', !t.sid]] : []),
      ['refresh', __('Yenile'), 'fa-arrows-rotate', false, 'Ctrl+R'],
      '-',
      ['copyPath', __('Bu klasörün yolunu kopyala'), 'fa-copy'],
      ...(remote ? [['cd', __('Terminalde bu klasöre git'), 'fa-terminal', !t.sid]] : [['reveal', __('Explorer’da aç'), 'fa-folder-tree', !P(t, side).path]]),
      ['hidden', X.ui.hidden ? __('Gizli dosyaları gizle') : __('Gizli dosyaları göster'), 'fa-eye', false, 'Ctrl+H'],
    ];
    const v = await ctxMenu(e.clientX, e.clientY, menu);
    if (!v) return;
    const p = P(t, side);
    if (v === 'open') openItem(t, side, one);
    else if (v === 'xfer') (remote ? download : upload)(t);
    else if (v === 'rename') rename(t, side);
    else if (v === 'delete') remove(t, side);
    else if (v === 'chmod') chmod(t);
    else if (v === 'du') calcSize(t);
    else if (v === 'mkdir') mkdir(t, side);
    else if (v === 'touch') touch(t);
    else if (v === 'refresh') loadPane(t, side, p.path, true);
    else if (v === 'hidden') toggleHidden();
    else if (v === 'reveal') inv('ssh:localOp', onRow ? 'reveal' : 'open', { path: onRow ? fullPath(t, side, one.name) : p.path });
    else if (v === 'copyPath') { const s = onRow ? items.map(f => fullPath(t, side, f.name)).join('\n') : p.path; navigator.clipboard.writeText(s).catch(() => {}); toast(__('Yol kopyalandı'), s.split('\n')[0]); }
    else if (v === 'cd') cdTerminal(t, onRow ? fullPath(t, side, one.name) : p.path);
  }
  async function hostCtx(id, x, y) {
    const h = host(id); if (!h) return;
    X.cur = id; renderHosts();
    const rdp = h.kind === 'rdp';
    const v = await ctxMenu(x, y, rdp ? [
      ['connect', __('Uzak Masaüstü ile bağlan'), 'fa-desktop', false, 'Enter'], '-',
      ['edit', __('Düzenle…'), 'fa-pen'], ['dup', __('Çoğalt'), 'fa-clone'], ['copy', __('Adresi kopyala'), 'fa-copy'], '-', ['del', __('Sil'), 'fa-trash-can'],
    ] : [
      ['connect', __('Bağlan (terminal + dosyalar)'), 'fa-plug', false, 'Enter'],
      ['term', __('Yalnızca terminal'), 'fa-terminal'],
      ['files', __('Yalnızca dosyalar (SFTP)'), 'fa-folder-open'], '-',
      ['edit', __('Düzenle…'), 'fa-pen'], ['dup', __('Çoğalt'), 'fa-clone'], ['copy', __('ssh komutunu kopyala'), 'fa-copy'], '-', ['del', __('Sil'), 'fa-trash-can'],
    ]);
    if (v === 'connect') openSession(id, 'split');
    else if (v === 'term') openSession(id, 'term');
    else if (v === 'files') openSession(id, 'files');
    else if (v === 'edit') editHost(id);
    else if (v === 'dup') { await inv('ssh:duplicate', id); await loadHosts(); renderHosts(); }
    else if (v === 'del') deleteHost(id);
    else if (v === 'copy') {
      const s = rdp ? hostAddr(h) : `ssh ${h.port && h.port !== 22 ? '-p ' + h.port + ' ' : ''}${h.auth === 'key' && h.keyPath ? '-i "' + h.keyPath + '" ' : ''}${h.user ? h.user + '@' : ''}${h.host}`;
      navigator.clipboard.writeText(s).catch(() => {}); toast(__('Kopyalandı'), s);
    }
  }
  function toggleHidden() {
    X.ui.hidden = !X.ui.hidden; saveState();
    X.tabs.forEach(t => { renderPane(t, 'local'); renderPane(t, 'remote'); });
  }

  /* ---------------- events ---------------- */
  const tabOf = el => { const s = el.closest('.ssh-sess'); return s && tab(s.dataset.sess); };
  const paneOf = el => { const p = el.closest('[data-pane]'); return p && p.dataset.pane; };
  let drag = null; // { t, side, names }
  function bind() {
    const body = document.getElementById('sshBody');
    view.addEventListener('click', e => {
      if (!e.target.closest('#sshCtx')) closeCtx();
      const a = e.target.closest('[data-act]');
      const t = tabOf(e.target) || curTab();
      if (a) {
        const k = a.dataset.act;
        if (k === 'newHost') editHost().then(id => { if (id && host(id) && host(id).kind === 'ssh' && !X.tabs.length) openSession(id); });
        else if (k === 'pickHost') pickHost();
        else if (k === 'reconnect' && t) { disconnect(t); t.sid = null; t.ch = null; connectTab(t, { reconnect: true }); }
        else if (k === 'disconnect' && t) disconnect(t);
        else if (k === 'dupSess' && t) openSession(t.hostId, t.view);
        else if (k === 'tunnels' && t) tunnelsDialog(t);
        else if (k === 'editThisHost' && t) editHost(t.hostId).then(id => { if (id) { t.title = sameTitle(host(id)).replace(/ \(\d+\)$/, ''); renderTabs(); } });
        else if (k === 'termReopen' && t) termReopen(t);
        else if (k === 'upload' && t) upload(t);
        else if (k === 'download' && t) download(t);
        else if (k === 'toggleHidden') toggleHidden();
        else if (k === 'clearXfers' && t) { for (const [id, j] of X.xfers) if (j.sid === t.sid && ['done', 'error', 'canceled'].includes(j.state)) X.xfers.delete(id); renderXfers(t); }
        return;
      }
      const cl = e.target.closest('[data-sclose]'); if (cl) { e.stopPropagation(); closeTab(cl.dataset.sclose); return; }
      const tb = e.target.closest('[data-stab]'); if (tb) { activate(tb.dataset.stab); return; }
      const vw = e.target.closest('button[data-view]'); if (vw && t) { setView(t, vw.dataset.view); return; }
      const hm = e.target.closest('[data-hostmenu]'); if (hm) { const r = hm.getBoundingClientRect(); e.stopPropagation(); hostCtx(hm.dataset.hostmenu, r.left, r.bottom + 2); return; }
      const ho = e.target.closest('[data-host]'); if (ho) { X.cur = ho.dataset.host; renderHosts(); return; }
      const gr = e.target.closest('[data-grp]'); if (gr) { X.collapsed[gr.dataset.grp] = !X.collapsed[gr.dataset.grp]; saveState(); renderHosts(); return; }
      const xc = e.target.closest('[data-xcancel]'); if (xc) { inv('ssh:xferCancel', xc.dataset.xcancel); return; }
      const xr = e.target.closest('[data-xreveal]'); if (xr) { const j = X.xfers.get(xr.dataset.xreveal); if (j) inv('ssh:localOp', 'open', { path: j.target }); return; }
      const so = e.target.closest('[data-sort]'); if (so && t) { const side = paneOf(so), p = P(t, side); if (p.sort.k === so.dataset.sort) p.sort.d *= -1; else p.sort = { k: so.dataset.sort, d: 1 }; renderPane(t, side); return; }
      const pa = e.target.closest('[data-spact]');
      if (pa && t) {
        const side = paneOf(pa), p = P(t, side), k = pa.dataset.spact;
        if (k === 'up') goUp(t, side);
        else if (k === 'back') goBack(t, side);
        else if (k === 'home') loadPane(t, side, side === 'remote' ? t.home : X.home);
        else if (k === 'refresh') loadPane(t, side, p.path, true);
        else if (k === 'mkdir') mkdir(t, side);
        else if (k === 'touch') touch(t);
        else if (k === 'pick') inv('ssh:localOp', 'pickDir', { path: p.path }).then(r => { if (r.path) loadPane(t, 'local', r.path); });
        return;
      }
      const row = e.target.closest('.ssh-row');
      if (row && t) {
        const side = paneOf(row), i = +row.dataset.i;
        row.closest('[data-role=list]').focus();
        if (i >= 0) selectRow(t, side, i, e);
        return;
      }
      const list = e.target.closest('[data-role=list]');
      if (list && t) { const side = paneOf(list); P(t, side).sel.clear(); renderPane(t, side); }
    });
    view.addEventListener('dblclick', e => {
      const ho = e.target.closest('[data-host]');
      if (ho && !e.target.closest('[data-hostmenu]')) { const h = host(ho.dataset.host); if (h) { if (h.kind === 'rdp') openRdp(h); else openSession(h.id, 'split'); } return; }
      const row = e.target.closest('.ssh-row'); const t = tabOf(e.target);
      if (row && t) { const side = paneOf(row), i = +row.dataset.i; if (i < 0) goUp(t, side); else openItem(t, side, P(t, side).view[i]); }
    });
    view.addEventListener('contextmenu', e => {
      const ho = e.target.closest('[data-host]');
      if (ho) { e.preventDefault(); hostCtx(ho.dataset.host, e.clientX, e.clientY); return; }
      const t = tabOf(e.target), list = e.target.closest('[data-role=list]');
      if (t && list) {
        e.preventDefault();
        const side = paneOf(list), row = e.target.closest('.ssh-row'), p = P(t, side);
        if (row && +row.dataset.i >= 0) {
          const f = p.view[+row.dataset.i];
          if (!p.sel.has(f.name)) selectRow(t, side, +row.dataset.i, null);
          paneCtx(t, side, e, true);
        } else paneCtx(t, side, e, false);
      }
      const tb = e.target.closest('[data-stab]');
      if (tb) {
        e.preventDefault();
        const t2 = tab(tb.dataset.stab);
        ctxMenu(e.clientX, e.clientY, [['dup', __('Aynı sunucuya yeni oturum'), 'fa-clone'], ['edit', __('Bağlantıyı düzenle…'), 'fa-pen'], '-', ['close', __('Sekmeyi kapat'), 'fa-xmark', false, 'Ctrl+W'], ['others', __('Diğer sekmeleri kapat'), 'fa-rectangle-xmark', X.tabs.length < 2]]).then(v => {
          if (v === 'dup') openSession(t2.hostId, t2.view);
          else if (v === 'edit') editHost(t2.hostId);
          else if (v === 'close') closeTab(t2.id);
          else if (v === 'others') X.tabs.filter(x => x !== t2).forEach(x => closeTab(x.id));
        });
      }
    });
    document.getElementById('sshCtx').addEventListener('click', e => { const b = e.target.closest('[data-ctx]'); if (b && !b.disabled) closeCtx(b.dataset.ctx); });
    document.addEventListener('mousedown', e => { if (!e.target.closest('#sshCtx')) closeCtx(); });
    document.getElementById('sshFilter').addEventListener('input', e => { X.filter = e.target.value; renderHosts(); });
    document.getElementById('sshHosts').addEventListener('keydown', e => {
      const ids = [...view.querySelectorAll('[data-host]')].map(x => x.dataset.host);
      let i = ids.indexOf(X.cur);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); X.cur = ids[i]; renderHosts(); const el = view.querySelector(`[data-host="${X.cur}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter' && X.cur) { e.preventDefault(); const h = host(X.cur); if (h.kind === 'rdp') openRdp(h); else openSession(h.id, 'split'); }
      else if (e.key === 'F2' && X.cur) { e.preventDefault(); editHost(X.cur); }
      else if (e.key === 'Delete' && X.cur) { e.preventDefault(); deleteHost(X.cur); }
    });
    // host list: drag to reorder
    let dragHost = null;
    const hl = document.getElementById('sshHosts');
    hl.addEventListener('dragstart', e => { const h = e.target.closest('[data-host]'); if (!h) return; dragHost = h.dataset.host; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); });
    hl.addEventListener('dragover', e => { if (!dragHost) return; e.preventDefault(); });
    hl.addEventListener('drop', async e => {
      if (!dragHost) return; e.preventDefault();
      const over = e.target.closest('[data-host]'); const from = dragHost; dragHost = null;
      if (!over || over.dataset.host === from) return;
      const ids = X.hosts.map(h => h.id).filter(id => id !== from);
      ids.splice(ids.indexOf(over.dataset.host), 0, from);
      const target = host(over.dataset.host), moved = host(from);
      if (target && moved && (target.group || '') !== (moved.group || '')) await inv('ssh:save', { ...moved, group: target.group || '' });
      await inv('ssh:reorder', ids); await loadHosts(); renderHosts();
    });
    hl.addEventListener('dragend', () => { dragHost = null; });

    // file lists: keyboard
    body.addEventListener('keydown', e => {
      const list = e.target.closest('[data-role=list]'); const t = tabOf(e.target);
      if (list && t) {
        const side = paneOf(list), p = P(t, side), k = e.key;
        if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); moveFocus(t, side, k === 'ArrowDown' ? 1 : -1, e); }
        else if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); moveFocus(t, side, k === 'PageDown' ? 15 : -15, e); }
        else if (k === 'Home' || k === 'End') { e.preventDefault(); moveFocus(t, side, k === 'End' ? 1e6 : -1e6, e); }
        else if (k === 'Enter') { e.preventDefault(); openItem(t, side, p.view[p.focus]); }
        else if (k === 'Backspace' || (e.altKey && k === 'ArrowUp')) { e.preventDefault(); goUp(t, side); }
        else if (e.altKey && k === 'ArrowLeft') { e.preventDefault(); goBack(t, side); }
        else if (k === 'Delete') { e.preventDefault(); remove(t, side); }
        else if (k === 'F2') { e.preventDefault(); rename(t, side); }
        else if (k === 'F5') { e.preventDefault(); (side === 'remote' ? download : upload)(t); }
        else if (k === 'F7') { e.preventDefault(); mkdir(t, side); }
        else if (k === 'Tab' && !modKey(e)) { e.preventDefault(); paneEl(t, side === 'remote' ? 'local' : 'remote').querySelector('[data-role=list]').focus(); }
        else if (modKey(e) && e.code === 'KeyA') { e.preventDefault(); p.sel = new Set(p.view.map(f => f.name)); renderPane(t, side); }
        else if (modKey(e) && e.code === 'KeyR') { e.preventDefault(); loadPane(t, side, p.path, true); }
        else if (modKey(e) && e.code === 'KeyH') { e.preventDefault(); toggleHidden(); }
        else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { // type to jump
          const now = Date.now(); p.typed = (now - (p.typedAt || 0) < 800 ? p.typed || '' : '') + k.toLowerCase(); p.typedAt = now;
          const i = p.view.findIndex(f => f.name.toLowerCase().startsWith(p.typed));
          if (i >= 0) { selectRow(t, side, i, null); const row = paneEl(t, side).querySelector(`.ssh-row[data-i="${i}"]`); if (row) row.scrollIntoView({ block: 'nearest' }); }
        }
        return;
      }
      const inp = e.target.closest('[data-role=path]');
      if (inp && t && e.key === 'Enter') { e.preventDefault(); const side = paneOf(inp); loadPane(t, side, inp.value.trim()); inp.blur(); }
      if (inp && t && e.key === 'Escape') { e.preventDefault(); inp.blur(); renderPane(t, paneOf(inp)); }
    });
    body.addEventListener('focusout', e => { const inp = e.target.closest && e.target.closest('[data-role=path]'); const t = tabOf(e.target); if (inp && t) setTimeout(() => renderPane(t, paneOf(inp)), 0); });

    // drag & drop: between panes, onto folders, and from Windows Explorer
    body.addEventListener('dragstart', e => {
      const row = e.target.closest('.ssh-row'); const t = tabOf(e.target);
      if (!row || !t || +row.dataset.i < 0) return;
      const side = paneOf(row), p = P(t, side), f = p.view[+row.dataset.i];
      if (!p.sel.has(f.name)) { p.sel = new Set([f.name]); renderPane(t, side); }
      drag = { t, side, names: [...p.sel] };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', drag.names.join('\n'));
    });
    body.addEventListener('dragend', () => { drag = null; view.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); });
    body.addEventListener('dragover', e => {
      const list = e.target.closest('[data-role=list]'); const t = tabOf(e.target);
      if (!list || !t) return;
      const side = paneOf(list);
      const external = !drag && e.dataTransfer.types.includes('Files');
      if (!drag && !external) return;
      if (external && side !== 'remote') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = drag && drag.side === side ? 'move' : 'copy';
      view.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
      const row = e.target.closest('.ssh-row.dir');
      (row && !(drag && drag.side === side && drag.names.includes(P(t, side).view[+row.dataset.i] && P(t, side).view[+row.dataset.i].name)) ? row : list).classList.add('drop');
    });
    body.addEventListener('drop', async e => {
      const list = e.target.closest('[data-role=list]'); const t = tabOf(e.target);
      view.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
      if (!list || !t) return;
      e.preventDefault();
      const side = paneOf(list), p = P(t, side);
      const row = e.target.closest('.ssh-row.dir');
      const sub = row && +row.dataset.i >= 0 ? p.view[+row.dataset.i] : row ? { name: '..', up: true } : null;
      const dest = sub ? (sub.up ? (side === 'remote' ? rparent(p.path) : lparent(p.path)) : fullPath(t, side, sub.name)) : p.path;
      if (!drag) { // files from Windows Explorer
        if (side !== 'remote') return;
        const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
        if (paths.length) transfer(t, 'up', paths, dest);
        return;
      }
      const d = drag; drag = null;
      if (d.t !== t) { toast(__('Farklı oturumlar arasında sürükleme desteklenmiyor')); return; }
      const srcPaths = d.names.map(n => fullPath(t, d.side, n));
      if (d.side !== side) { transfer(t, d.side === 'local' ? 'up' : 'down', srcPaths, dest); return; }
      if (dest === p.path || !sub) return;
      // same pane onto a folder: move
      const n = d.names.length;
      if (!(await confirmBox(__('Taşı'), n === 1 ? __('“{name}” “{dest}” klasörüne taşınsın mı?', { name: d.names[0], dest }) : __('{n} öğe “{dest}” klasörüne taşınsın mı?', { n, dest }), __('Taşı')))) return;
      for (const nm of d.names) {
        const a = { from: fullPath(t, side, nm), to: side === 'remote' ? rjoin(dest, nm) : ljoin(dest, nm) };
        const r = side === 'remote' ? await inv('ssh:op', t.sid, 'rename', a) : await inv('ssh:localOp', 'rename', a);
        if (r.error) { toast(__('Taşınamadı: {name}', { name: nm }), r.error); break; }
      }
      p.sel.clear();
      loadPane(t, side, p.path);
    });

    // resizers
    view.addEventListener('mousedown', e => {
      const g = e.target.closest('[data-drag]'); if (!g) return;
      e.preventDefault();
      const kind = g.dataset.drag;
      const t = tabOf(g);
      const box = kind === 'split' ? t.el.querySelector('.ssh-content').getBoundingClientRect() : view.getBoundingClientRect();
      document.body.classList.add(kind === 'split' ? 'db-dragging' : 'db-dragging-x');
      const mv = ev => {
        if (kind === 'side') { X.ui.sideW = Math.max(180, Math.min(520, ev.clientX - box.left)); applyUi(); }
        else { X.ui.split = Math.max(0.15, Math.min(0.85, (ev.clientY - box.top) / box.height)); X.tabs.forEach(x => x.el.querySelector('.ssh-content').style.setProperty('--ssh-split', Math.round(X.ui.split * 100) + '%')); }
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); document.body.classList.remove('db-dragging', 'db-dragging-x'); saveState(); X.tabs.forEach(fitTerm); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    g2();
  }
  function g2() {
    // mode-wide shortcuts (only while SSH mode is on and no dialog is open)
    window.addEventListener('keydown', e => {
      if (view.hidden || !document.getElementById('sshModal').hidden) return;
      const k = e.key.toLowerCase(), t = curTab();
      if (modKey(e) && e.altKey && e.code === 'KeyN') { e.preventDefault(); editHost(); }
      else if (modKey(e) && !e.shiftKey && !e.altKey && e.code === 'KeyW' && t) { e.preventDefault(); e.stopPropagation(); closeTab(t.id); }
      else if (modKey(e) && e.altKey && e.code === 'KeyT' && t) { e.preventDefault(); setView(t, t.view === 'term' ? 'split' : 'term'); }
      else if (modKey(e) && e.altKey && e.code === 'KeyF' && t) { e.preventDefault(); setView(t, t.view === 'files' ? 'split' : 'files'); }
      else if (modKey(e) && (k === 'pagedown' || k === 'pageup')) { e.preventDefault(); e.stopPropagation(); cycleTab(k === 'pagedown' ? 1 : -1); }
    }, true);
  }
  function applyUi() {
    const s = view.querySelector('.ssh-side'); if (s) s.style.width = X.ui.sideW + 'px';
  }

  /* ---------------- main-process events ---------------- */
  api.on('ssh:data', (ch, d) => { const t = tabByCh(ch); if (t) t.term.write(d); });
  api.on('ssh:exit', (ch) => {
    const t = tabByCh(ch); if (!t) return;
    t.ch = null;
    if (t.kind === 'term') { const d = t.el.querySelector('[data-role=dot]'); if (d) d.className = 'ssh-dot off'; }
    if (t.status === 'ok') t.term.write(`\r\n\x1b[2m— ${__('kabuk kapandı · yeni kabuk için Enter')} —\x1b[0m\r\n`);
  });
  api.on('ssh:closed', (sid, reason) => {
    const t = tabBySid(sid); if (!t) return;
    t.sid = null; t.ch = null;
    if (t.status === 'ok') { t.status = 'closed'; t.error = reason || ''; t.term.write(`\r\n\x1b[33m— ${__('bağlantı kapandı')} —\x1b[0m\r\n`); }
    for (const j of X.xfers.values()) if (j.sid === sid) j.tab = t.id;
    renderOver(t); renderTabs(); renderHosts();
  });
  api.on('ssh:xfer', onXfer);
  api.on('agent-access', kind => { if (kind === 'ssh') loadHosts(); }); // "her zaman hatırla" in a Claude / Codex question
  api.on('ssh:xferAsk', onXferAsk);
  api.on('ssh:tunnels', (sid, list) => {
    const t = tabBySid(sid); if (!t) return;
    const errs = list.filter(x => x.error && !(t.tunnels.find(o => o.localPort === x.localPort) || {}).error);
    t.tunnels = list; renderBar(t);
    errs.forEach(x => toast(__('Tünel {local} → {host}:{port} çalışmadı', { local: x.localPort, host: x.remoteHost, port: x.remotePort }), x.error));
  });

  try {
    SHORTCUTS.push(
      { group: 'SSH', keys: 'Ctrl+Alt+N', label: __('Yeni SSH / RDP bağlantısı') },
      { group: 'SSH', keys: 'Ctrl+W', label: __('Oturum sekmesini kapat') },
      { group: 'SSH', keys: 'Ctrl+PageDown / Ctrl+PageUp', label: __('Sonraki / önceki oturum') },
      { group: 'SSH', keys: 'Ctrl+Alt+T / Ctrl+Alt+F', label: __('Yalnızca terminal / yalnızca dosyalar') },
      { group: 'SSH', keys: 'F5', label: __('Seçilenleri diğer panele aktar (yükle / indir)') },
      { group: 'SSH', keys: 'F2 / F7 / Delete', label: __('Yeniden adlandır / yeni klasör / sil') },
      { group: 'SSH', keys: __('Backspace / Alt+Sol'), label: __('Üst klasör / geri') },
      { group: 'SSH', keys: 'Ctrl+H', label: __('Gizli dosyaları göster / gizle') },
      { group: 'SSH', keys: __('Sağ tık (terminal)'), label: __('Seçim varsa kopyala, yoksa yapıştır') },
    );
  } catch (_) {}

  /* ---------------- terminal-only tabs (docker exec into a container) ---------------- */
  function openDockerTerm(c) {
    const title = c.name + (c.target === 'local' ? '' : ' @ ' + (c.host || __('sunucu')));
    const t = {
      id: uid(), kind: 'term', hostId: null, title, status: 'ok', view: 'term', ch: null, sid: c.target === 'local' ? null : c.target,
      docker: c, local: {}, remote: {}, hist: { local: [], remote: [] }, tunnels: [],
    };
    t.el = document.createElement('div');
    t.el.className = 'ssh-sess ssh-termtab';
    t.el.dataset.sess = t.id;
    t.el.innerHTML = `<div class="ssh-bar"><span class="ssh-dot busy" data-role="dot"></span><i class="fa-brands fa-docker ssh-dki"></i><span class="ssh-addr">${esc(c.target === 'local' ? __('bu bilgisayar') : c.host || '')} · docker exec · <b>${esc(c.name)}</b></span><span class="ssh-grow"></span>
        <button class="ssh-tb" data-act="termReopen" title="${esc(__('Kabuğu yeniden aç'))}"><i class="fa-solid fa-rotate-right"></i>${__('Yeniden aç')}</button></div>
      <div class="ssh-content" data-layout="term"><div class="ssh-term"><div class="ssh-termhost" data-role="term"></div></div></div>`;
    document.getElementById('sshBody').appendChild(t.el);
    const term = new Terminal({ fontFamily: MONO_FONT, fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 10000, allowProposedApi: true, theme: termTheme(), linkHandler: typeof termLinkHandler !== 'undefined' ? termLinkHandler : undefined });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit); t.term = term; t.fit = fit;
    term.open(t.el.querySelector('[data-role=term]'));
    term.onData(d => { if (t.ch) api.send('ssh:write', t.ch, d); else if (d === '\r') termReopen(t); });
    term.onResize(({ cols, rows }) => { if (t.ch) api.send('ssh:resize', t.ch, cols, rows); });
    term.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (!IS_MAC && e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) { if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); } return false; }
      if (!IS_MAC && e.ctrlKey && k === 'v') return false;
      return true;
    });
    t.el.querySelector('.ssh-term').addEventListener('contextmenu', async e => {
      e.preventDefault();
      if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); }
      else { try { const s = await navigator.clipboard.readText(); if (s && t.ch) term.paste(s); } catch (_) {} }
    });
    t.ro = new ResizeObserver(() => fitTerm(t));
    t.ro.observe(t.el.querySelector('.ssh-term'));
    X.tabs.push(t);
    activate(t.id);
    termReopen(t);
    return t;
  }
  async function termReopen(t) {
    if (t.ch || t.opening) return;
    t.opening = true;
    fitTerm(t);
    t.el.querySelector('[data-role=dot]').className = 'ssh-dot busy';
    const r = await inv('docker:term', t.docker.target, t.docker.id, t.term.cols, t.term.rows);
    t.opening = false;
    if (r.error) { t.term.write(`\r\n\x1b[31m${r.error}\x1b[0m\r\n`); t.el.querySelector('[data-role=dot]').className = 'ssh-dot off'; return; }
    t.ch = r.ch;
    t.el.querySelector('[data-role=dot]').className = 'ssh-dot ok';
    t.term.focus();
  }

  window.sshMode = {
    openDockerTerm(c) {
      // the SSH view may live in a window of its own; the tab has to open where it is seen
      const elsewhere = (typeof ONLY !== 'undefined' && ONLY && ONLY !== 'ssh') || (typeof ONLY !== 'undefined' && !ONLY && typeof DETACHED !== 'undefined' && DETACHED.has('ssh'));
      if (elsewhere) { toast(__('SSH modu ayrı pencerede'), __('Konteyner terminali için o penceredeki Docker düğmesini kullan ya da SSH’yi bu pencereye geri al.')); return; }
      if (S.mode !== 'ssh') setMode('ssh');
      openDockerTerm(c);
    },
    async show() {
      if (!X.built) {
        build();
        const st = (await inv('ssh:getState')).state;
        if (st) { Object.assign(X.ui, st.ui || {}); X.collapsed = st.collapsed || {}; }
        await loadHosts();
        applyUi();
        renderHosts(); renderTabs();
        if (!X.cur && X.hosts[0]) X.cur = X.hosts[0].id;
        renderHosts();
        document.getElementById('sshHosts').focus();
      } else {
        const th = termTheme();
        X.tabs.forEach(t => { t.term.options.theme = th; });
        loadHosts().then(renderHosts);
        requestAnimationFrame(() => { const t = curTab(); if (t) { fitTerm(t); if (t.view === 'term') t.term.focus(); } });
      }
    },
    hide() { closeCtx(); saveState(); },
  };
})();
