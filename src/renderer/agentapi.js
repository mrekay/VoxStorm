/* What Claude / Codex sessions can do in this window through VoxStorm (the MCP tools of agentlink.js).
   The main process calls window.agentApi.<name>(args) here and hands the answer back to the agent.
   Everything the user sees is VoxStorm's own UI: the IDE, the git window, the DB mode, ui.js dialogs.
   `by` is the agent's name ("Claude" / "Codex"), `from` the pty id of the asking session. */
(() => {
  'use strict';
  const fail = error => ({ error });
  const projOfDir = dir => dir && (termFileProject(dir.replace(/[\\/]+$/, '') + SEP + 'x') || S.projects.find(p => normPath(p.path) === normPath(dir)));

  /* ---------------- IDE ---------------- */
  async function needProjectFile(fp) {
    const p = termFileProject(fp);
    if (!p) return fail(__('Dosya VoxStorm’daki projelerin hiçbirinde değil; IDE yalnızca proje dosyalarını açar.'));
    const st = await api.invoke('fs:stat', fp).catch(() => null);
    if (!st || !st.exists) return fail(__('Dosya bulunamadı: {path}', { path: fp }));
    if (st.dir) return fail(__('Bu bir klasör, dosya değil: {path}', { path: fp }));
    return { p };
  }
  const showExplorer = () => { if (!IDE.ui.ex) { IDE.ui.ex = true; saveIdeUi(); } };
  function toProject(p) {
    if (S.mode !== 'ide') setMode('ide');
    if (IDE.project !== p.id) switchIdeProject(p.id);
  }

  async function showFile({ path: fp, line, openTab = true, by = 'Claude' }) {
    const r = await needProjectFile(fp); if (r.error) return r;
    showExplorer();
    if (openTab) openTermFile(fp, line || 0, 0, by);
    else { toProject(r.p); revealInTree(fp, by); }
    return { ok: true, project: r.p.name };
  }

  // a few places of a file marked with the agent's notes (cleared by the next call, or with ×)
  let marks = [];
  function clearMarks() {
    for (const m of marks) { try { if (m.cls) m.doc.removeLineClass(m.cls, 'background', 'agent-hl'); if (m.w) m.w.clear(); } catch (_) {} }
    marks = [];
  }
  async function highlight({ path: fp, ranges, by = 'Claude' }) {
    const r = await needProjectFile(fp); if (r.error) return r;
    showExplorer();
    toProject(r.p);
    const list = (Array.isArray(ranges) ? ranges : []).slice(0, 30).map(x => ({ from: Math.max(1, x.line | 0), to: Math.max(1, (x.end_line || x.line) | 0), note: String(x.note || '').slice(0, 600) }));
    if (!list.length) return fail(__('En az bir satır aralığı ver (line, end_line, note).'));
    await openFile(fp, { line: list[0].from });
    revealInTree(fp, by);
    const f = IDE.files[fp];
    if (!f || !f.doc) return fail(__('Dosya açılamadı.'));
    clearMarks();
    const doc = f.doc, last = doc.lineCount();
    for (const x of list) {
      const a = Math.min(x.from, last), b = Math.min(Math.max(x.to, x.from), last);
      for (let l = a; l <= b; l++) marks.push({ doc, cls: doc.addLineClass(l - 1, 'background', 'agent-hl') });
      if (x.note) {
        const el = document.createElement('div');
        el.className = 'agent-note';
        el.innerHTML = `<i class="fa-solid fa-robot"></i><b>${esc(by)}</b><span></span><button title="${esc(__('İşaretleri kaldır'))}" aria-label="${esc(__('İşaretleri kaldır'))}"><i class="fa-solid fa-xmark"></i></button>`;
        el.querySelector('span').textContent = x.note;
        el.querySelector('button').onclick = clearMarks;
        marks.push({ doc, w: doc.addLineWidget(b - 1, el, { coverGutter: false, noHScroll: true }) });
      }
    }
    return { ok: true, project: r.p.name, marked: list.length };
  }

  function editorState() {
    const p = proj(IDE.project), s = p ? ist() : null, fp = s && s.file, cm = IDE.cm;
    const out = { mode: S.mode, project: p ? { name: p.name, path: p.path } : null, file: fp || null, openFiles: s ? s.tabs.slice() : [] };
    if (fp && cm && IDE.files[fp] && cm.getDoc() === IDE.files[fp].doc) {
      const c = cm.getCursor();
      out.cursor = { line: c.line + 1, column: c.ch + 1 };
      if (cm.somethingSelected()) {
        const a = cm.getCursor('from'), b = cm.getCursor('to');
        out.selection = { from: { line: a.line + 1, column: a.ch + 1 }, to: { line: b.line + 1, column: b.ch + 1 }, text: cm.getSelection().slice(0, 20000) };
      }
    }
    out.unsavedFiles = Object.keys(IDE.files).filter(isDirty);
    return out;
  }

  /* ---------------- git ---------------- */
  // the git window with the project's changes; a path selects that file's diff. With ask, a bar on top
  // asks the user to accept or reject and the answer goes back to the agent.
  async function showDiff({ path: fp, cwd, ask, message, by = 'Claude' }) {
    const p = (fp && termFileProject(fp)) || projOfDir(cwd);
    if (!p) return fail(__('Proje bulunamadı: dosya ya da oturum klasörü VoxStorm’daki bir projenin içinde olmalı.'));
    GIT.pid = p.id;
    GW.view = 'changes';
    await openGitWin('changes');
    if (!GW.ov || !GW.ov.repo) return fail(__('Bu proje bir git deposu değil.'));
    if (fp) {
      const rel = fp.slice(p.path.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
      const ov = GW.ov, hit = (k, l) => l.some(x => x.path === rel) && k;
      const kind = hit('unstaged', ov.conflicted) || hit('unstaged', ov.unstaged) || hit('staged', ov.staged) || hit('untracked', ov.untracked);
      if (!kind) return { ok: true, project: p.name, note: __('Bu dosyada bekleyen değişiklik yok; değişiklik listesi gösterildi.') };
      GW.sel = { type: 'file', kind, path: rel };
      renderGwList();
      await showGwDetail();
    }
    if (!ask) return { ok: true, project: p.name };
    const box = $('#gwDetail');
    const bar = document.createElement('div');
    bar.className = 'agent-review';
    bar.innerHTML = `<i class="fa-solid fa-robot"></i><span><b>${__('{agent} soruyor:', { agent: esc(by) })}</b> <span></span></span><button class="btn" data-ar="no"><i class="fa-solid fa-rotate-left"></i> ${__('Geri al')}</button><button class="btn primary" data-ar="yes"><i class="fa-solid fa-check"></i> ${__('Kabul et')}</button>`;
    bar.querySelector('span span').textContent = message || __('Bu değişiklikleri kabul ediyor musun?');
    box.prepend(bar);
    $('#gitWin').hidden = false;
    return new Promise(resolve => {
      const done = v => { clearInterval(watch); bar.remove(); resolve(v); };
      bar.addEventListener('click', e => { const b = e.target.closest('[data-ar]'); if (b) done({ ok: true, answer: b.dataset.ar === 'yes' ? 'accepted' : 'rejected' }); });
      // closed, or the user moved to another file: no answer
      const watch = setInterval(() => { if ($('#gitWin').hidden || !bar.isConnected) done({ ok: true, answer: 'dismissed' }); }, 700);
    });
  }

  /* ---------------- asking ---------------- */
  async function askUser({ question, detail, options, multi, allowText, by = 'Claude', project }) {
    const opts = (Array.isArray(options) ? options : []).slice(0, 12).map((o, i) => (typeof o === 'string' ? { label: o } : o))
      .map((o, i) => ({ label: String(o.label || '').slice(0, 200), hint: String(o.description || '').slice(0, 300), value: String(o.label || i) }));
    const base = { title: __('{agent} soruyor', { agent: by }) + (project ? ' · ' + project : ''), icon: 'fa-robot', message: String(question || '').slice(0, 2000), detail: String(detail || '').slice(0, 4000), ok: __('Gönder'), cancel: __('Cevap verme') };
    let r;
    if (opts.length) {
      r = await uiAsk(Object.assign(base, { choices: opts.map((o, i) => Object.assign(o, { checked: !multi && i === 0 })), radio: !multi },
        allowText ? { input: '', placeholder: __('ya da kendin yaz…'), maxLength: 2000 } : {}));
      if (r == null) return { answered: false };
      const values = Array.isArray(r) ? r : r.values, text = Array.isArray(r) ? '' : (r.text || '').trim();
      return { answered: true, choices: values, text: text || undefined };
    }
    if (allowText !== false) {
      r = await uiAsk(Object.assign(base, { input: '', placeholder: __('Cevabın…'), maxLength: 4000 }));
      return r == null ? { answered: false } : { answered: true, text: r };
    }
    r = await uiAsk(Object.assign(base, { ok: __('Evet'), cancel: __('Hayır') }));
    return { answered: true, yes: !!r };
  }

  /* ---------------- terminals ---------------- */
  const termInfo = t => ({ id: t.id, title: t.title, kind: t.kind === 'claude' ? (t.agent === 'codex' ? 'codex' : 'claude') : t.kind, project: (proj(t.projectId) || {}).name || null, status: t.status, exited: !!t.exited, active: t.id === S.active });
  const terms = () => S.tabs.filter(t => t.term && (t.kind === 'claude' || t.kind === 'shell'));
  function findTerm(ref) {
    const r = String(ref || '').trim(), low = r.toLocaleLowerCase('tr');
    return terms().find(t => t.id === r) || terms().find(t => String(t.title).toLocaleLowerCase('tr') === low) || null;
  }
  function listTerminals({ from }) {
    return { terminals: terms().map(t => Object.assign(termInfo(t), t.id === from ? { you: true } : {})) };
  }
  function readTerminal({ terminal, lines }) {
    const t = findTerm(terminal); if (!t) return fail(__('Terminal bulunamadı. list_terminals ile bak.'));
    const buf = t.term.buffer.active, n = Math.max(1, Math.min(3000, lines | 0 || 200));
    let end = buf.length - 1;
    while (end > 0) { const l = buf.getLine(end); if (l && l.translateToString(true).trim()) break; end--; }
    const out = [];
    for (let y = Math.max(0, end - n + 1); y <= end; y++) {
      const l = buf.getLine(y); if (!l) continue;
      const s = l.translateToString(true);
      if (l.isWrapped && out.length) out[out.length - 1] += s; else out.push(s);
    }
    return { terminal: termInfo(t), text: out.join('\n') };
  }
  async function runInTerminal({ command, cwd, title, from, by = 'Claude' }) {
    const src = tabById(from);
    const p = projOfDir(cwd) || (src && proj(src.projectId));
    if (!p) return fail(__('Proje bulunamadı: komut VoxStorm’daki bir projenin klasöründe çalışır.'));
    const t = await openTerminal({ kind: 'shell', projectId: p.id, title: String(title || '').slice(0, 48) || `${by}: ${String(command).slice(0, 30)}` });
    if (!t || t.exited) return fail(__('Terminal açılamadı.'));
    t.renamed = true;
    await new Promise(r => setTimeout(r, 500)); // the shell draws its prompt first
    api.send('pty:write', t.id, String(command) + '\r');
    renderAll();
    return { ok: true, terminal: termInfo(t) };
  }
  const allowedPairs = new Set();
  async function sendToSession({ target, message, from, by = 'Claude' }) {
    const t = findTerm(target);
    if (!t || t.kind !== 'claude') return fail(__('Oturum bulunamadı (yalnızca Claude / Codex oturumlarına mesaj gönderilir). list_terminals ile bak.'));
    if (t.id === from) return fail(__('Kendi oturumuna mesaj gönderemezsin.'));
    if (t.exited) return fail(__('Bu oturum kapanmış.'));
    const text = String(message || '').replace(/\r?\n/g, ' ').slice(0, 20000);
    if (!text.trim()) return fail(__('Mesaj boş.'));
    const key = from + '>' + t.id;
    if (!allowedPairs.has(key)) {
      const src = tabById(from);
      const r = await uiAsk({
        title: __('{agent} başka bir oturuma yazmak istiyor', { agent: by }), icon: 'fa-comments', focusCancel: true,
        message: `“${src ? src.title : by}” → “${t.title}”${proj(t.projectId) ? ' (' + proj(t.projectId).name + ')' : ''}`,
        detail: __('Mesaj o oturuma senin yazmışsın gibi gönderilir:'), code: text.slice(0, 1500),
        ok: __('Gönder'), cancel: __('Gönderme'), check: __('Bu iki oturum arasında bir daha sorma'),
      });
      if (!r.ok) return fail(__('Kullanıcı mesajın gönderilmesine izin vermedi.'));
      if (r.checked) allowedPairs.add(key);
    }
    api.send('pty:write', t.id, text);
    setTimeout(() => { if (!t.exited) api.send('pty:write', t.id, '\r'); }, 300);
    return { ok: true, sentTo: termInfo(t) };
  }

  /* ---------------- DB ---------------- */
  // the query in a DB mode tab; a read-only looking one runs at once, anything else waits for the user
  async function showQuery({ connId, sql, database }) {
    if (!window.dbApi) return fail(__('DB modu bu pencerede yok.'));
    await dbApi.openInDbMode({ sql: String(sql || ''), connId, db: database || undefined, title: 'Claude' });
    const readOnly = /^\s*(select|with|show|describe|desc|explain|pragma)\b/i.test(String(sql || '')) && !/;\s*\S/.test(String(sql).trim().replace(/;\s*$/, ''));
    if (readOnly && dbApi.runActive) { await dbApi.runActive(); return { ok: true, ran: true }; }
    return { ok: true, ran: false, note: __('Sorgu DB modunda açıldı; salt okunur görünmediği için çalıştırmayı kullanıcıya bıraktım.') };
  }

  /* ---------------- plugins ---------------- */
  const pluginTools = () => (window.pluginHost && pluginHost.agentTools ? pluginHost.agentTools() : []);
  async function callPluginTool({ plugin, tool, args }) {
    if (!window.pluginHost || !pluginHost.agentCall) return fail(__('Eklentiler bu pencerede yok.'));
    return pluginHost.agentCall(String(plugin || ''), String(tool || ''), args && typeof args === 'object' ? args : {});
  }

  /* ---------------- themes (themes.js) ---------------- */
  const getTheme = () => Themes.current();
  async function saveTheme({ name, dark, colors, popup, image, panels, ansi, termColors, by = 'Claude' }) {
    const c = colors && typeof colors === 'object' ? colors : {};
    const bad = Object.keys(c).filter(k => c[k] && !Themes.norm(c[k]));
    if (bad.length) return fail(__('Geçersiz renk (#rrggbb olmalı): {list}', { list: bad.join(', ') }));
    const known = Themes.FIELDS.map(f => f[0]), unknown = Object.keys(c).filter(k => !known.includes(k));
    if (unknown.length) return fail(__('Bilinmeyen renk alanı: {list}. Alanlar: {fields}', { list: unknown.join(', '), fields: known.join(', ') }));
    const an = ansi && typeof ansi === 'object' ? ansi : {};
    const badA = Object.keys(an).filter(k => !Themes.ANSI.includes(k) || (an[k] && !Themes.norm(an[k])));
    if (badA.length) return fail(__('Geçersiz ansi rengi: {list}. Alanlar: {fields}', { list: badA.join(', '), fields: Themes.ANSI.join(', ') }));
    const pn = {}; // each save is a new theme: only the panel pictures given now
    if (panels) for (const k of Object.keys(panels)) if (panels[k]) pn[k] = panels[k];
    const t = await Themes.save({ name: String(name || __('Yeni tema')), dark, colors: c, popup, image, panels: pn, ansi: an, by }, { termColors });
    toast(__('{agent} yeni bir tema uyguladı', { agent: by }), __('“{name}” · Tema menüsünden değiştirebilir ya da düzenleyebilirsin.', { name: t.name }));
    return { ok: true, id: t.id, name: t.name };
  }

  window.agentApi = { getTheme, saveTheme, showFile, highlight, editorState, showDiff, askUser, listTerminals, readTerminal, runInTerminal, sendToSession, showQuery, pluginTools, callPluginTool };
  window.agentShowFile = (fp, line, openTab, by) => showFile({ path: fp, line, openTab, by });
})();
