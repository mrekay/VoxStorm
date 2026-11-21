/* VoxStorm plugin SDK: loaded into every plugin page before the page's own scripts.
   Gives the page a global `vox` object; every call is a message to VoxStorm and returns a Promise. */
(() => {
  'use strict';
  if (window.vox) return;
  const host = window.parent;
  const pending = new Map();
  const handlers = Object.create(null);
  const buttonFns = new Map(), commandFns = new Map(), outputFns = new Map(), menuFns = new Map(), toolFns = new Map();
  let seq = 0;

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      host.postMessage({ vox: 1, id, method, params: params || {} }, '*');
    });
  }
  function fire(event, data) {
    for (const fn of handlers[event] || []) {
      try { fn(data); } catch (err) { console.error(err); report(err); }
    }
  }
  function applyTheme(t) {
    if (!t || !t.vars) return;
    const s = document.documentElement.style;
    for (const k of Object.keys(t.vars)) if (t.vars[k]) s.setProperty(k, t.vars[k]);
    document.documentElement.dataset.theme = t.dark ? 'dark' : 'light';
    s.colorScheme = t.dark ? 'dark' : 'light';
  }
  window.addEventListener('message', e => {
    if (e.source !== host) return;
    const m = e.data;
    if (!m || m.vox !== 1) return;
    if (m.re) {
      const p = pending.get(m.re);
      if (!p) return;
      pending.delete(m.re);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      return;
    }
    if (m.event === 'theme') applyTheme(m.data);
    if (m.event === 'state') vox.state = m.data;
    if (m.event === 'button') { const fn = buttonFns.get(m.data && m.data.id); if (fn) try { fn(); } catch (err) { report(err); } }
    if (m.event === 'shell-output') { const fn = outputFns.get(m.data && m.data.runId); if (fn) try { fn(m.data.text, m.data.stream); } catch (err) { report(err); } }
    if (m.event === 'command') { const fn = commandFns.get(m.data && m.data.id); if (fn) try { fn(); } catch (err) { report(err); } }
    if (m.event === 'agent-call') { // a Claude / Codex session called one of this plugin's tools
      const d = m.data || {}, fn = toolFns.get(d.tool);
      Promise.resolve().then(() => { if (!fn) throw new Error('Araç kayıtlı değil: ' + d.tool); return fn(d.args || {}); })
        .then(result => call('agent.result', { callId: d.callId, result }), err => call('agent.result', { callId: d.callId, error: String(err && err.message || err) }))
        .catch(report);
    }
    if (m.event === 'menu') { const fn = menuFns.get(m.data && m.data.id); if (fn) try { fn(m.data.context || {}); } catch (err) { report(err); } }
    fire(m.event, m.data);
  });
  function report(err) { call('log', { level: 'error', text: String(err && (err.stack || err.message) || err) }).catch(() => {}); }
  window.addEventListener('error', e => report(e.error || e.message));
  window.addEventListener('unhandledrejection', e => report(e.reason));

  /* Tooltips: an element's title shows in VoxStorm's own themed bubble (drawn by the app, so it is not cut
     off at the edge of a small panel). The title moves to data-tip so the browser's bubble never shows. */
  let tipEl = null, tipTimer = 0, tipWarm = 0;
  function tipHide() {
    clearTimeout(tipTimer);
    if (tipEl) { tipEl = null; tipWarm = Date.now(); call('ui.tip', {}).catch(() => {}); }
  }
  function tipShow(el) {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    tipEl = el;
    call('ui.tip', { text: el.dataset.tip, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }).catch(() => {});
  }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[title],[data-tip]');
    if (el && el.hasAttribute('title')) {
      const t = el.getAttribute('title'); el.removeAttribute('title');
      if (t) { el.dataset.tip = t; if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t.split('\n')[0]); }
    }
    if (el === tipEl) return;
    tipHide();
    if (!el || !el.dataset.tip) return;
    const target = el;
    tipTimer = setTimeout(() => tipShow(target), Date.now() - tipWarm < 400 ? 40 : 450);
  }, true);
  document.addEventListener('mouseout', e => { if (tipEl && !(e.relatedTarget && tipEl.contains(e.relatedTarget))) tipHide(); }, true);
  for (const ev of ['mousedown', 'keydown', 'wheel', 'scroll', 'blur']) window.addEventListener(ev, tipHide, true);
  document.addEventListener('mouseleave', tipHide);

  // a menu item list: functions stay here, only ids and labels go to the app
  function menuItems(items, keep) {
    return (Array.isArray(items) ? items : []).map(it => {
      if (!it || it.separator || it === '-') return { separator: true };
      if (it.label && !it.id && !it.onClick) return { label: String(it.label) };
      if (keep && typeof it.onClick === 'function') menuFns.set(it.id, it.onClick);
      const { onClick, ...o } = it;
      return o;
    });
  }
  // where to open a menu: a mouse event, an element (under it) or { x, y }; in this page's coordinates
  function menuAt(at) {
    if (!at) return null;
    if (typeof at.clientX === 'number') return { x: at.clientX, y: at.clientY };
    if (at.getBoundingClientRect) { const r = at.getBoundingClientRect(); return { x: r.left, y: r.bottom + 2, alignRight: r.right }; }
    if (typeof at.x === 'number' && typeof at.y === 'number') return { x: at.x, y: at.y };
    return null;
  }

  const on = (event, fn) => {
    (handlers[event] = handlers[event] || []).push(fn);
    return () => { handlers[event] = (handlers[event] || []).filter(f => f !== fn); };
  };

  const vox = {
    /** resolves once VoxStorm answered: { id, name, version, permissions, theme, state, panel } */
    ready: null,
    info: null,
    state: null,
    on,
    log: (...a) => call('log', { level: 'info', text: a.map(String).join(' ') }),
    app: {
      state: () => call('app.state'),
      setMode: mode => call('app.setMode', { mode }),
      openUrl: url => call('app.openUrl', { url }),
    },
    ui: {
      toast: (title, body) => call('ui.toast', { title, body }),
      confirm: opts => call('ui.confirm', typeof opts === 'string' ? { message: opts } : opts),
      prompt: opts => call('ui.prompt', typeof opts === 'string' ? { message: opts } : opts),
      addButton: opts => { if (opts && typeof opts.onClick === 'function') buttonFns.set(opts.id, opts.onClick); const { onClick, ...o } = opts || {}; if (o.menu) o.menu = menuItems(o.menu, true); return call('ui.addButton', o); },
      updateButton: (id, changes) => { const o = Object.assign({}, changes, { id }); if (o.menu) o.menu = menuItems(o.menu, true); return call('ui.updateButton', o); },
      removeButton: id => { buttonFns.delete(id); return call('ui.removeButton', { id }); },
      addPanel: opts => call('ui.addPanel', opts),
      openPanel: id => call('ui.openPanel', { id }),
      closePanel: id => call('ui.closePanel', { id }),
      /** a menu at a mouse event / element / {x,y}: resolves with the chosen item's id, or null */
      showMenu: (items, at) => {
        const list = Array.isArray(items) ? items : (items && items.items) || [];
        const fns = new Map(list.filter(it => it && typeof it.onClick === 'function').map(it => [it.id, it.onClick]));
        return call('ui.showMenu', { items: menuItems(list, false), at: menuAt(at || (items && items.at)) }).then(id => {
          const fn = id != null && fns.get(id);
          if (fn) try { fn(); } catch (err) { report(err); }
          return id == null ? null : id;
        });
      },
      /** an item in one of VoxStorm's right-click menus: menu 'session' | 'project' | 'file'; onClick(context) */
      addMenuItem: opts => { if (opts && typeof opts.onClick === 'function') menuFns.set(opts.id, opts.onClick); const { onClick, ...o } = opts || {}; return call('ui.addMenuItem', o); },
      removeMenuItem: id => { menuFns.delete(id); return call('ui.removeMenuItem', { id }); },
    },
    commands: {
      register: opts => { if (opts && typeof opts.run === 'function') commandFns.set(opts.id, opts.run); const { run, ...o } = opts || {}; return call('commands.register', o); },
      unregister: id => { commandFns.delete(id); return call('commands.unregister', { id }); },
    },
    notify: (title, body) => call('notify', { title, body }),
    storage: {
      get: key => call('storage.get', { key }),
      set: (key, value) => call('storage.set', { key, value }),
      remove: key => call('storage.remove', { key }),
      keys: () => call('storage.keys'),
    },
    fs: {
      read: path => call('fs.read', { path }),
      list: path => call('fs.list', { path }),
      stat: path => call('fs.stat', { path }),
      write: (path, content) => call('fs.write', { path, content }),
      mkdir: path => call('fs.mkdir', { path }),
    },
    shell: {
      /** opts: { cwd, timeout (ms, max 1 hour), onOutput(text, 'stdout'|'stderr') } -> { code, stdout, stderr, error, stopped } */
      run: (command, opts) => {
        const o = Object.assign({}, opts, { command });
        const fn = o.onOutput; delete o.onOutput;
        if (typeof fn === 'function') { o.runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); outputFns.set(o.runId, fn); }
        return call('shell.run', o).finally(() => { if (o.runId) outputFns.delete(o.runId); });
      },
      /** stops every command this plugin started */
      stop: () => call('shell.stop'),
    },
    agent: {
      /** a tool Claude / Codex sessions can call through VoxStorm ("claude" permission):
          { name, description, inputSchema (JSON Schema), run: async args => result } */
      registerTool: opts => { if (opts && typeof opts.run === 'function') toolFns.set(opts.name, opts.run); const { run, ...o } = opts || {}; return call('agent.registerTool', o); },
      unregisterTool: name => { toolFns.delete(name); return call('agent.unregisterTool', { name }); },
    },
    claude: {
      newSession: opts => call('claude.newSession', opts || {}),
      send: (text, opts) => call('claude.send', Object.assign({}, opts, { text })),
    },
  };
  vox.ready = call('hello', { page: location.pathname }).then(info => {
    vox.info = info; vox.state = info.state;
    applyTheme(info.theme);
    if (info.place) document.documentElement.dataset.place = info.place;
    return info;
  });
  window.vox = vox;
})();
