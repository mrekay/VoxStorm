/* IDE menu strip (Dosya, Düzen, Seçim, Görünüm, Terminal, Yardım), the find & replace bar
   and the editor commands behind them. Loaded before app.js; everything here runs only after
   app.js has set up the editor (setupIdeMenu is called from init), so app.js globals are fine. */

const IM = { open: null, ret: null, armed: false, items: [], closed: {} };
const FB = { rep: false, case: false, word: false, regex: false, overlay: null, annot: null, timer: null, last: '' };

/* ---------- editor helpers ---------- */
function edFile() { const fp = IDE.project && ist().file, f = fp && IDE.files[fp]; return f && f.doc ? fp : null; }
function edRun(fn) {
  if (!edFile()) { toast('Önce bir metin dosyası aç'); return; }
  const cm = IDE.cm;
  if (IDE.mdView.has(edFile())) { IDE.mdView.delete(edFile()); showFile(); }
  fn(cm); cm.focus();
}
const edExec = name => () => edRun(cm => cm.execCommand(name));
/* the lines to work on: the selected lines, or the whole file when nothing is selected */
function edLines(cm) {
  if (!cm.somethingSelected()) return { from: cm.firstLine(), to: cm.lastLine() };
  const a = cm.getCursor('from'), b = cm.getCursor('to');
  return { from: a.line, to: b.ch === 0 && b.line > a.line ? b.line - 1 : b.line };
}
function edMapLines(cm, fn) {
  const { from, to } = edLines(cm);
  cm.operation(() => {
    for (let i = from; i <= to; i++) {
      const t = cm.getLine(i), n = fn(t);
      if (n !== t) cm.replaceRange(n, CodeMirror.Pos(i, 0), CodeMirror.Pos(i, t.length));
    }
  });
}
function edCase(upper) {
  edRun(cm => {
    if (!cm.somethingSelected()) { const w = cm.findWordAt(cm.getCursor()); cm.setSelection(w.anchor, w.head); }
    cm.replaceSelections(cm.getSelections().map(s => (upper ? s.toUpperCase() : s.toLowerCase())), 'around');
  });
}
function edTrim() {
  edRun(cm => {
    let n = 0;
    edMapLines(cm, t => { const r = t.replace(/[ \t]+$/, ''); if (r !== t) n++; return r; });
    toast('Sondaki boşluklar', n ? `${n} satır temizlendi` : 'Temizlenecek boşluk yok');
  });
}
function edIndent(toTabs) {
  edRun(cm => {
    const ts = cm.getOption('tabSize') || 2;
    edMapLines(cm, t => {
      const lead = t.match(/^[ \t]*/)[0]; if (!lead) return t;
      let col = 0; for (const c of lead) col = c === '\t' ? col + ts - (col % ts) : col + 1;
      return (toTabs ? '\t'.repeat(Math.floor(col / ts)) + ' '.repeat(col % ts) : ' '.repeat(col)) + t.slice(lead.length);
    });
  });
}
function edDedupe() {
  edRun(cm => {
    const { from, to } = edLines(cm), seen = new Set(), out = [];
    for (let i = from; i <= to; i++) { const t = cm.getLine(i); if (!seen.has(t)) { seen.add(t); out.push(t); } }
    const n = to - from + 1 - out.length;
    if (n) cm.replaceRange(out.join('\n'), CodeMirror.Pos(from, 0), CodeMirror.Pos(to, cm.getLine(to).length));
    toast('Yinelenen satırlar', n ? `${n} satır kaldırıldı` : 'Yinelenen satır yok');
  });
}
function edJson(compact) {
  edRun(cm => {
    const sel = cm.somethingSelected(), src = sel ? cm.getSelection() : cm.getValue();
    let obj; try { obj = JSON.parse(src); } catch (e) { toast('JSON biçimlendirilemedi', e.message); return; }
    const out = compact ? JSON.stringify(obj) : JSON.stringify(obj, null, cm.getOption('indentUnit') || 2);
    if (out === src) return;
    if (sel) cm.replaceSelection(out, 'around');
    else { const c = cm.getCursor(); cm.replaceRange(out, CodeMirror.Pos(cm.firstLine(), 0), CodeMirror.Pos(cm.lastLine())); cm.setCursor(c); }
  });
}
function edBlockComment() {
  edRun(cm => cm.operation(() => {
    for (const r of cm.listSelections()) {
      let from = r.from(), to = r.to();
      if (r.empty()) { from = CodeMirror.Pos(from.line, 0); to = CodeMirror.Pos(to.line, cm.getLine(to.line).length); }
      if (!cm.uncomment(from, to)) cm.blockComment(from, to, { fullLines: r.empty() });
    }
  }));
}
/* copy the line(s) upwards: the cursor stays on the upper copy */
function edDupUp(cm) { const sels = cm.listSelections(); cm.execCommand('duplicateLine'); cm.setSelections(sels); }
function edFold(kind) {
  edRun(cm => {
    if (kind === 'toggle') cm.foldCode(cm.getCursor());
    else cm.execCommand(kind === 'all' ? 'foldAll' : 'unfoldAll');
  });
}
async function edClip(kind) {
  if (!edFile()) return;
  const cm = IDE.cm;
  try {
    if (kind === 'paste') { const t = await navigator.clipboard.readText(); cm.replaceSelection(t); }
    else if (cm.somethingSelected()) {
      await navigator.clipboard.writeText(cm.getSelections().join('\n'));
      if (kind === 'cut') cm.replaceSelection('');
    }
  } catch (e) { toast('Pano kullanılamadı', cleanErr(e)); }
  cm.focus();
}
/* editor-only keys (the editor must have focus); listed in SHORTCUTS for the Kısayollar page */
const IM_KEYS = {
  'Ctrl-F': () => imFind(false),
  'Ctrl-/': 'toggleComment', 'Ctrl-7': 'toggleComment', 'Shift-Alt-A': () => edBlockComment(),
  'Shift-Alt-Down': 'duplicateLine', 'Shift-Alt-Up': edDupUp,
  'Alt-Up': 'swapLineUp', 'Alt-Down': 'swapLineDown', 'Shift-Ctrl-K': 'deleteLine', 'Ctrl-J': 'joinLines',
  'Ctrl-D': 'selectNextOccurrence', 'Shift-Ctrl-L': 'findAllUnder', 'Ctrl-L': 'selectLine',
  'Ctrl-Alt-Up': 'addCursorToPrevLine', 'Ctrl-Alt-Down': 'addCursorToNextLine',
  'Ctrl-M': 'goToBracket', 'Ctrl-Q': cm => cm.foldCode(cm.getCursor()), 'Shift-Alt-F': () => edJson(false),
  'Ctrl-Enter': 'insertLineAfter', 'Shift-Ctrl-Enter': 'insertLineBefore',
};

/* ---------- recent / recently closed files (hooks called from app.js) ---------- */
function imNoteOpened(s, fp, ok) {
  const list = (s.recent || []).filter(x => x !== fp);
  s.recent = ok ? [fp, ...list].slice(0, 12) : list;
}
function imNoteClosed(list) {
  const pid = IDE.project; if (!pid) return;
  const st = IM.closed[pid] || (IM.closed[pid] = []);
  list.forEach(fp => { const i = st.indexOf(fp); if (i >= 0) st.splice(i, 1); st.push(fp); });
  if (st.length > 20) st.splice(0, st.length - 20);
}
function imReopenClosed() {
  const st = IM.closed[IDE.project] || [], open = ist().tabs;
  while (st.length) { const fp = st.pop(); if (!open.includes(fp)) { openFile(fp); return; } }
  toast('Yeniden açılacak dosya yok');
}

/* ---------- file commands ---------- */
async function imSaveAs() {
  const fp = edFile(), r = projRoot();
  if (!fp || !r) { toast('Önce bir metin dosyası aç'); return; }
  const name = await askName({
    title: 'Farklı kaydet', hint: 'Proje köküne göre yol · alt klasör için / kullanabilirsin',
    value: relOf(fp).replace(/\\/g, '/'), select: [Math.max(relOf(fp).lastIndexOf('\\'), relOf(fp).lastIndexOf('/')) + 1, relOf(fp).length - (extOf(fp) ? extOf(fp).length + 1 : 0)],
    validate: v => nameError(v, true),
  });
  if (!name) return;
  const to = joinP(r, name.replace(/[\\/]+/g, SEP).replace(/^[\\/]+|[\\/]+$/g, '')); // SEP: \ on Windows, / on macOS
  if (normPath(to) === normPath(fp)) { saveFile(fp); return; }
  let st = { exists: false }; try { st = await api.invoke('fs:stat', to); } catch (_) {}
  if (st.exists && st.dir) { toast('Kaydedilemedi', 'Bu adda bir klasör var.'); return; }
  if (st.exists && !(await uiConfirm({ title: 'Dosya zaten var', message: `${relOf(to)} dosyasının üzerine yazılsın mı?`, ok: 'Üzerine yaz', danger: true }))) return;
  const f = IDE.files[fp];
  let text = f.doc.getValue();
  if (f.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (f.bom) text = '\uFEFF' + text;
  try { await api.invoke('fs:create', to); await api.invoke('fs:write', to, text); } catch (e) { toast('Kaydedilemedi', cleanErr(e)); return; }
  // the tab now shows the new file; the old file stays as it is on disk
  const s = ist();
  const old = Object.keys(IDE.files).find(k => normPath(k) === normPath(to));
  if (old) { s.tabs = s.tabs.filter(k => k !== old); delete IDE.files[old]; }
  s.tabs = s.tabs.map(k => (k === fp ? to : k));
  s.file = to;
  if (!Object.values(IDE.state).some(x => x.tabs.includes(fp))) delete IDE.files[fp];
  IDE.files[to] = Object.assign(f, { gen: f.doc.changeGeneration(true), eol0: f.eol, conflict: false, missing: false });
  imNoteOpened(s, to, true);
  IDE.dirCache = {}; delete IDE.index[IDE.project];
  saveIdeState(); showFile(); revealInTree(to);
  toast('Kaydedildi', relOf(to));
}
async function imRevert() {
  const fp = edFile(); if (!fp) return;
  if (isDirty(fp) && !(await uiConfirm({ title: 'Diskteki sürüme dön', message: `${baseName(fp)} dosyasındaki kaydedilmemiş değişiklikler silinecek.`, ok: 'Diskten yükle', danger: true }))) return;
  await reloadFromDisk(fp, true);
}
function imSaveAll() { toolbar('saveall'); }
// kind 'claude' with shell = an AI ('claude' | 'codex'); kind 'shell' with the shell's key
function imTerminal(kind, shell) {
  const p = IDE.project; if (!p) { toast('Önce bir proje ekle'); return; }
  if (!IDE.ui.panel) { IDE.ui.panel = true; saveIdeUi(); }
  openTerminal(kind === 'shell' ? { kind, shell, projectId: p } : { kind, agent: shell || 'claude', projectId: p });
}
function imToggleUi(key, def) { IDE.ui[key] = !(IDE.ui[key] ?? def); saveIdeUi(); imApplyUi(); }
function imApplyUi() {
  const cm = IDE.cm;
  cm.setOption('lineNumbers', IDE.ui.lnum !== false);
  cm.setOption('rulers', IDE.ui.ruler ? [{ column: 80, className: 'im-ruler' }, { column: 120, className: 'im-ruler' }] : false);
  cm.setOption('foldGutter', IDE.ui.fold !== false);
  cm.setOption('gutters', IDE.ui.fold !== false ? ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'] : ['CodeMirror-linenumbers']);
}

/* ---------- menus ---------- */
const IM_MENUS = [['file', 'Dosya'], ['edit', 'Düzen'], ['sel', 'Seçim'], ['view', 'Görünüm'], ['term', 'Terminal'], ['help', 'Yardım']];
/* each item: [label, icon, key, run, { dis, chk }] — '-' is a separator, { lbl } a section title */
function imItems(id) {
  const fp = IDE.project && ist().file, text = !!edFile(), cm = IDE.cm, s = IDE.project ? ist() : { tabs: [] };
  const hasProj = !!proj(IDE.project), sel = text && cm.somethingSelected();
  const h = text ? cm.historySize() : { undo: 0, redo: 0 };
  const E = (l, i, k, run, o = {}) => ({ l, i, k, run, ...o });
  const notText = { dis: !text };
  if (id === 'file') {
    const recent = (s.recent || []).filter(x => x !== fp).slice(0, 6);
    return [
      E('Yeni dosya', 'fa-solid fa-file-circle-plus', 'Ctrl+N', () => newEntry(projRoot(), false), { dis: !hasProj }),
      E('Yeni klasör', 'fa-solid fa-folder-plus', '', () => newEntry(projRoot(), true), { dis: !hasProj }),
      '-',
      E('Dosyaya git…', 'fa-solid fa-bolt', 'Ctrl+P', () => openPalette(''), { dis: !hasProj }),
      E('Son kapatılanı yeniden aç', 'fa-solid fa-clock-rotate-left', '', imReopenClosed, { dis: !(IM.closed[IDE.project] || []).some(x => !s.tabs.includes(x)) }),
      ...(recent.length ? [{ lbl: 'Son açılanlar' }, ...recent.map(r => E(baseName(r), null, dirOf(relOf(r)), () => openFile(r).then(() => revealInTree(r)), { file: r }))] : []),
      '-',
      E('Kaydet', 'fa-solid fa-floppy-disk', 'Ctrl+S', () => saveFile(), { dis: !(fp && isDirty(fp)) }),
      E('Farklı kaydet…', 'fa-regular fa-floppy-disk', 'Ctrl+Shift+S', imSaveAs, notText),
      E('Tümünü kaydet', 'fa-solid fa-copy', '', imSaveAll, { dis: !s.tabs.some(isDirty) }),
      E('Diskteki sürüme dön', 'fa-solid fa-rotate', '', imRevert, notText),
      '-',
      E('Yolu kopyala', 'fa-regular fa-copy', '', () => copyText(fp, 'Yol kopyalandı'), { dis: !fp }),
      E('Göreli yolu kopyala', 'fa-solid fa-link', '', () => copyText(relOf(fp), 'Göreli yol kopyalandı'), { dis: !fp }),
      E('Dosya ağacında göster', 'fa-solid fa-folder-tree', '', () => { if (!IDE.ui.ex) toolbar('ex'); revealInTree(fp); }, { dis: !fp }),
      E('Dosya Gezgini’nde göster', 'fa-regular fa-folder-open', '', () => api.invoke('fs:reveal', fp).catch(e => toast('Açılamadı', cleanErr(e))), { dis: !fp }),
      '-',
      E('Dosyayı kapat', 'fa-solid fa-xmark', 'Ctrl+W', () => closeFile(fp), { dis: !fp }),
      E('Kaydedilmişleri kapat', 'fa-solid fa-check-double', '', () => closeFiles(s.tabs.filter(k => !isDirty(k))), { dis: !s.tabs.some(k => !isDirty(k)) }),
      E('Tümünü kapat', 'fa-solid fa-square-xmark', '', () => closeFiles([...s.tabs]), { dis: !s.tabs.length }),
    ];
  }
  if (id === 'edit') return [
    E('Geri al', 'fa-solid fa-rotate-left', 'Ctrl+Z', edExec('undo'), { dis: !h.undo }),
    E('Yinele', 'fa-solid fa-rotate-right', 'Ctrl+Y', edExec('redo'), { dis: !h.redo }),
    '-',
    E('Kes', 'fa-solid fa-scissors', 'Ctrl+X', () => edClip('cut'), { dis: !sel }),
    E('Kopyala', 'fa-regular fa-copy', 'Ctrl+C', () => edClip('copy'), { dis: !sel }),
    E('Yapıştır', 'fa-regular fa-paste', 'Ctrl+V', () => edClip('paste'), notText),
    '-',
    E('Bul', 'fa-solid fa-magnifying-glass', 'Ctrl+F', () => imFind(false), notText),
    E('Değiştir', 'fa-solid fa-right-left', 'Ctrl+H', () => imFind(true), notText),
    E('Sonrakini bul', 'fa-solid fa-arrow-down', 'F3', () => imFindStep(false), notText),
    E('Öncekini bul', 'fa-solid fa-arrow-up', 'Shift+F3', () => imFindStep(true), notText),
    E('Projede ara', 'fa-solid fa-magnifying-glass-arrow-right', 'Ctrl+Shift+F', () => openProjectSearch(), { dis: !hasProj }),
    '-',
    E('Satır yorumu', 'fa-solid fa-hashtag', 'Ctrl+/', edExec('toggleComment'), notText),
    E('Blok yorumu', 'fa-regular fa-comment', 'Shift+Alt+A', edBlockComment, notText),
    '-',
    { lbl: 'Dönüştür' },
    E('BÜYÜK HARFE çevir', 'fa-solid fa-arrow-up-a-z', '', () => edCase(true), notText),
    E('küçük harfe çevir', 'fa-solid fa-arrow-down-a-z', '', () => edCase(false), notText),
    E('Satırları sırala (A→Z)', 'fa-solid fa-arrow-down-short-wide', '', edExec('sortLinesInsensitive'), notText),
    E('Satırları ters sırala (Z→A)', 'fa-solid fa-arrow-up-wide-short', '', edExec('reverseSortLinesInsensitive'), notText),
    E('Yinelenen satırları kaldır', 'fa-solid fa-filter', '', edDedupe, notText),
    E('Sondaki boşlukları sil', 'fa-solid fa-eraser', '', edTrim, notText),
    E('Girintiyi boşluğa çevir', 'fa-solid fa-indent', '', () => edIndent(false), notText),
    E('Girintiyi sekmeye çevir', 'fa-solid fa-outdent', '', () => edIndent(true), notText),
    E('JSON biçimlendir', 'fa-solid fa-code', 'Shift+Alt+F', () => edJson(false), notText),
    E('JSON sıkıştır', 'fa-solid fa-compress', '', () => edJson(true), notText),
  ];
  if (id === 'sel') return [
    E('Tümünü seç', 'fa-solid fa-object-group', 'Ctrl+A', edExec('selectAll'), notText),
    E('Satırı seç', 'fa-solid fa-grip-lines', 'Ctrl+L', edExec('selectLine'), notText),
    E('Sonraki eşleşmeyi de seç', 'fa-solid fa-i-cursor', 'Ctrl+D', edExec('selectNextOccurrence'), notText),
    E('Tüm eşleşmeleri seç', 'fa-solid fa-layer-group', 'Ctrl+Shift+L', edExec('findAllUnder'), notText),
    E('Üste imleç ekle', 'fa-solid fa-arrow-up', 'Ctrl+Alt+↑', edExec('addCursorToPrevLine'), notText),
    E('Alta imleç ekle', 'fa-solid fa-arrow-down', 'Ctrl+Alt+↓', edExec('addCursorToNextLine'), notText),
    E('Parantez içini seç', 'fa-solid fa-code', '', edExec('selectBetweenBrackets'), notText),
    '-',
    E('Satırı yukarı taşı', 'fa-solid fa-angle-up', 'Alt+↑', edExec('swapLineUp'), notText),
    E('Satırı aşağı taşı', 'fa-solid fa-angle-down', 'Alt+↓', edExec('swapLineDown'), notText),
    E('Satırı yukarı çoğalt', 'fa-solid fa-angles-up', 'Shift+Alt+↑', () => edRun(edDupUp), notText),
    E('Satırı aşağı çoğalt', 'fa-solid fa-angles-down', 'Shift+Alt+↓', edExec('duplicateLine'), notText),
    E('Satırı sil', 'fa-solid fa-delete-left', 'Ctrl+Shift+K', edExec('deleteLine'), notText),
    E('Satırları birleştir', 'fa-solid fa-compress', 'Ctrl+J', edExec('joinLines'), notText),
    E('Alta satır ekle', 'fa-solid fa-turn-down', 'Ctrl+Enter', edExec('insertLineAfter'), notText),
    E('Üste satır ekle', 'fa-solid fa-turn-up', 'Ctrl+Shift+Enter', edExec('insertLineBefore'), notText),
    '-',
    E('Satıra git…', 'fa-solid fa-arrow-right-to-bracket', 'Ctrl+G', () => openPalette(':'), notText),
    E('Eşleşen paranteze git', 'fa-solid fa-code', 'Ctrl+M', edExec('goToBracket'), notText),
  ];
  if (id === 'view') {
    const md = !!fp && isMarkdown(fp);
    return [
      E('Dosya gezgini', 'fa-solid fa-table-columns', 'Ctrl+Shift+E', () => toolbar('ex'), { chk: !!IDE.ui.ex }),
      E('Claude paneli', 'fa-solid fa-terminal', 'Ctrl+Shift+D', () => toolbar('panel'), { chk: !!IDE.ui.panel }),
      E(IDE.ui.dock === 'right' ? 'Paneli alta al' : 'Paneli sağa al', 'fa-solid fa-table-columns', '', () => toolbar('dock')),
      E('Projede ara görünümü', 'fa-solid fa-magnifying-glass', '', () => openProjectSearch(), { dis: !hasProj }),
      '-',
      E('Satır sarma', 'fa-solid fa-arrow-turn-down', 'Alt+Z', () => toggleWrap(), { chk: !!IDE.ui.wrap }),
      E('Satır numaraları', 'fa-solid fa-list-ol', '', () => imToggleUi('lnum', true), { chk: IDE.ui.lnum !== false }),
      E('Katlama kenarı', 'fa-solid fa-caret-down', '', () => imToggleUi('fold', true), { chk: IDE.ui.fold !== false }),
      E('Cetvel (80 / 120. sütun)', 'fa-solid fa-ruler-vertical', '', () => imToggleUi('ruler', false), { chk: !!IDE.ui.ruler }),
      ...(md ? [E('Markdown görünümü', 'fa-solid fa-eye', '', () => { if (IDE.mdView.has(fp)) IDE.mdView.delete(fp); else IDE.mdView.add(fp); showFile(); }, { chk: IDE.mdView.has(fp) })] : []),
      '-',
      E('Bulunduğu bloğu katla / aç', 'fa-solid fa-square-minus', 'Ctrl+Q', () => edFold('toggle'), notText),
      E('Tümünü katla', 'fa-solid fa-compress', '', () => edFold('all'), notText),
      E('Tüm katlamaları aç', 'fa-solid fa-expand', '', () => edFold('none'), notText),
      '-',
      E('Yazıyı büyüt', 'fa-solid fa-magnifying-glass-plus', '', () => toolbar('bigger'), { dis: IDE.ui.size >= 22 }),
      E('Yazıyı küçült', 'fa-solid fa-magnifying-glass-minus', '', () => toolbar('smaller'), { dis: IDE.ui.size <= 10 }),
      E('Varsayılan yazı boyutu', 'fa-solid fa-text-height', `${IDE.ui.size}px`, () => { IDE.ui.size = 13; saveIdeUi(); }, { dis: IDE.ui.size === 13 }),
    ];
  }
  if (id === 'term') return [
    E('Yeni Claude oturumu', 'fa-solid fa-robot', '', () => imTerminal('claude'), { dis: !hasProj }),
    ...(INFO && INFO.codex ? [E('Yeni Codex oturumu', 'fa-brands fa-openai', '', () => imTerminal('claude', 'codex'), { dis: !hasProj })] : []),
    // this system's shells: PowerShell / Komut İstemi / Git Bash on Windows, zsh / bash elsewhere
    ...Object.keys(SHELLS).map(k => E('Yeni ' + SHELLS[k].name, k === 'bash' && IS_WIN ? 'fa-brands fa-git-alt' : 'fa-solid fa-terminal', '', () => imTerminal('shell', k), { dis: !hasProj })),
    '-',
    E(askLabel() + ' (dosya / seçim)', 'fa-solid fa-comment-dots', '', () => askClaude(), { dis: !fp, cls: 'accent' }),
    '-',
    E('Git / GitHub paneli', 'fa-brands fa-git-alt', 'Ctrl+Shift+G', () => toggleGitPanel()),
    E('Dosya ağacını ve git durumunu yenile', 'fa-solid fa-arrows-rotate', '', () => { IDE.dirCache = {}; delete IDE.index[IDE.project]; renderTree(); refreshGit(); }, { dis: !hasProj }),
  ];
  if (id === 'help') return [
    E('Klavye kısayolları', 'fa-regular fa-keyboard', 'F1', () => openSettings('kisayol')),
    E('Ayarlar', 'fa-solid fa-gear', 'Ctrl+,', () => openSettings()),
    E('Karşılama ekranı', 'fa-solid fa-house', 'Ctrl+Shift+O', () => api.send('app:welcome')),
    '-',
    E('Hakkında ve güncellemeler', 'fa-solid fa-circle-info', '', () => openSettings('hakkinda')),
  ];
  return [];
}
function imRenderBar() {
  $('#imBar').innerHTML = IM_MENUS.map(([id, l], i) => `<button class="imb" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-imb="${id}" tabindex="${i ? -1 : 0}">${l}</button>`).join('');
}
function imOpen(id, focus) {
  const btn = $(`#imBar [data-imb="${id}"]`), m = $('#imDrop'); if (!btn) return;
  if (!IM.open && !$('#imBar').contains(document.activeElement)) IM.ret = document.activeElement;
  IM.open = id;
  IM.items = [];
  let html = '';
  for (const it of imItems(id)) {
    if (it === '-') { if (html && !html.endsWith('<div class="sep"></div>')) html += '<div class="sep"></div>'; continue; }
    if (it.lbl) { html += `<div class="lbl">${esc(it.lbl)}</div>`; continue; }
    const n = IM.items.push(it) - 1, chk = it.chk !== undefined;
    const ic = chk ? `<i class="mic fa-solid fa-check${it.chk ? '' : ' off'}"></i>` : it.file ? fileIcon(it.file) : `<i class="mic ${it.i || ''}"></i>`;
    html += `<button data-imi="${n}" role="${chk ? 'menuitemcheckbox' : 'menuitem'}" ${chk ? `aria-checked="${!!it.chk}"` : ''} class="${it.cls || ''}" ${it.dis ? 'disabled' : ''} tabindex="-1"${it.file ? ` title="${esc(it.file)}"` : ''}><span class="mi">${ic}${esc(it.l)}</span>${it.k ? `<code class="${it.file ? 'ell' : ''}">${esc(it.k)}</code>` : ''}</button>`;
  }
  m.innerHTML = html.replace(/<div class="sep"><\/div>$/, '');
  m.hidden = false;
  $$('#imBar .imb').forEach(b => { const on = b === btn; b.classList.toggle('on', on); b.setAttribute('aria-expanded', on); b.tabIndex = on ? 0 : -1; });
  const w = $('#win').getBoundingClientRect(), r = btn.getBoundingClientRect();
  m.style.maxHeight = Math.max(200, w.bottom - r.bottom - 12) + 'px';
  m.style.left = Math.max(4, Math.min(r.left - w.left, w.width - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.bottom - w.top + 2) + 'px';
  m.tabIndex = -1;
  if (focus) { const first = m.querySelector('button:not(:disabled)'); (first || m).focus(); } else m.focus();
}
function imClose(restore) {
  if (IM.open) {
    IM.open = null;
    $('#imDrop').hidden = true;
    $$('#imBar .imb').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-expanded', 'false'); });
  }
  if (restore) imRestoreFocus();
}
function imRestoreFocus() {
  const r = IM.ret; IM.ret = null;
  if (r && r.isConnected && r !== document.body && typeof r.focus === 'function') r.focus();
  else if (edFile()) IDE.cm.focus();
  else if (document.activeElement && $('#imBar').contains(document.activeElement)) document.activeElement.blur();
}
function imFocusBar(id) {
  if (S.mode !== 'ide') return;
  const a = document.activeElement;
  if (!IM.ret && !$('#imBar').contains(a) && !$('#imDrop').contains(a)) IM.ret = a;
  imClose();
  const b = $(`#imBar [data-imb="${id || IM_MENUS[0][0]}"]`);
  $$('#imBar .imb').forEach(x => { x.tabIndex = x === b ? 0 : -1; });
  b.focus();
}
function imRun(i) {
  const it = IM.items[i]; if (!it || it.dis) return;
  imClose(); imRestoreFocus();
  try { it.run(); } catch (e) { toast('İşlem yapılamadı', cleanErr(e)); }
}
function imShift(id, d) { const i = IM_MENUS.findIndex(m => m[0] === id); return IM_MENUS[(i + d + IM_MENUS.length) % IM_MENUS.length][0]; }

/* ---------- find & replace bar ---------- */
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function fbQuery() {
  const q = $('#fbFind').value;
  if (!q) return null;
  let src;
  if (FB.regex) src = q; else if (FB.word) src = `(?<![\\p{L}\\p{N}_])${reEsc(q)}(?![\\p{L}\\p{N}_])`; else src = null;
  if (src == null) return { query: q, fold: !FB.case, re: new RegExp(reEsc(q), FB.case ? 'g' : 'gi'), plain: true };
  const flags = (FB.case ? '' : 'i') + (FB.word && !FB.regex ? 'u' : '');
  let re; try { re = new RegExp(src, flags); } catch (e) { return { err: 'Geçersiz düzenli ifade' }; }
  if (re.test('')) return { err: 'İfade boş metinle eşleşiyor' };
  return { query: re, fold: !FB.case, re: new RegExp(src, flags + 'g'), src, flags };
}
function fbHighlight() {
  const cm = IDE.cm;
  if (FB.overlay) { cm.removeOverlay(FB.overlay); FB.overlay = null; }
  if (FB.annot) { FB.annot.clear(); FB.annot = null; }
  const q = !$('#findBar').hidden && fbQuery();
  if (q && !q.err) {
    const re = q.re;
    FB.overlay = { token(stream) {
      re.lastIndex = stream.pos;
      const m = re.exec(stream.string);
      if (m && m.index === stream.pos) { stream.pos += m[0].length || 1; return 'search-hit'; }
      if (m) stream.pos = m.index; else stream.skipToEnd();
    } };
    cm.addOverlay(FB.overlay);
    if (cm.showMatchesOnScrollbar) FB.annot = cm.showMatchesOnScrollbar(q.query, q.fold, 'im-scroll-hit');
  }
  fbCount();
}
function fbCount() {
  const el = $('#fbCount'), q = fbQuery(), cm = IDE.cm;
  $('#findBar').classList.toggle('no-hit', false);
  if (!q) { el.textContent = ''; return; }
  if (q.err) { el.textContent = q.err; $('#findBar').classList.add('no-hit'); return; }
  if (!edFile()) { el.textContent = ''; return; }
  const from = cm.getCursor('from'), to = cm.getCursor('to'), cur = cm.getSearchCursor(q.query, CodeMirror.Pos(cm.firstLine(), 0), { caseFold: q.fold });
  let n = 0, at = 0;
  while (n < 9999 && cur.findNext()) { n++; if (!at && CodeMirror.cmpPos(cur.from(), from) === 0 && CodeMirror.cmpPos(cur.to(), to) === 0) at = n; }
  el.textContent = !n ? 'Sonuç yok' : at ? `${at} / ${n}${n >= 9999 ? '+' : ''}` : `${n}${n >= 9999 ? '+' : ''} eşleşme`;
  $('#findBar').classList.toggle('no-hit', !n);
}
function imFind(rep) {
  if (S.mode !== 'ide') return;
  const fp = edFile(); if (!fp) { toast('Önce bir metin dosyası aç'); return; }
  if (IDE.mdView.has(fp)) { IDE.mdView.delete(fp); showFile(); }
  const cm = IDE.cm, sel = cm.somethingSelected() && cm.getSelection();
  const inp = $('#fbFind');
  if (sel && !sel.includes('\n') && sel.length < 300) inp.value = FB.regex ? reEsc(sel) : sel;
  else if (!inp.value && FB.last) inp.value = FB.last;
  $('#findBar').hidden = false;
  fbShowRep(!!rep);
  fbHighlight();
  if (rep && inp.value) { $('#fbRep').focus(); $('#fbRep').select(); } else { inp.focus(); inp.select(); }
}
function fbShowRep(on) {
  FB.rep = on;
  $('#fbRepRow').hidden = !on;
  $('#fbTog').setAttribute('aria-expanded', on);
  $('#fbTog').innerHTML = `<i class="fa-solid fa-chevron-${on ? 'down' : 'right'}"></i>`;
}
function fbClose() {
  $('#findBar').hidden = true;
  fbHighlight();
  if (edFile()) IDE.cm.focus();
}
function imFindStep(back) {
  if (!edFile()) return;
  const cm = IDE.cm;
  if ($('#findBar').hidden || !$('#fbFind').value) {
    if (!$('#fbFind').value) {
      const sel = cm.somethingSelected() ? cm.getSelection() : (() => { const w = cm.findWordAt(cm.getCursor()); return cm.getRange(w.anchor, w.head); })();
      if (!sel || sel.includes('\n') || !sel.trim()) { imFind(false); return; }
      $('#fbFind').value = FB.regex ? reEsc(sel) : sel;
    }
  }
  const q = fbQuery(); if (!q || q.err) { fbCount(); return; }
  FB.last = $('#fbFind').value;
  let cur = cm.getSearchCursor(q.query, cm.getCursor(back ? 'from' : 'to'), { caseFold: q.fold });
  if (!(back ? cur.findPrevious() : cur.findNext())) {
    cur = cm.getSearchCursor(q.query, back ? CodeMirror.Pos(cm.lastLine()) : CodeMirror.Pos(cm.firstLine(), 0), { caseFold: q.fold });
    if (!(back ? cur.findPrevious() : cur.findNext())) { fbCount(); return; }
  }
  cm.setSelection(cur.from(), cur.to());
  cm.scrollIntoView({ from: cur.from(), to: cur.to() }, 80);
  fbCount();
}
/* the replacement text for one match: regex mode understands $1, $2 … */
function fbRepText(q, m) {
  const rep = $('#fbRep').value;
  return q.plain || !Array.isArray(m) ? rep : m[0].replace(new RegExp(q.src, q.flags), rep);
}
function fbReplace(all) {
  const fp = edFile(), q = fbQuery(); if (!fp || !q || q.err) return;
  const cm = IDE.cm;
  FB.last = $('#fbFind').value;
  if (all) {
    let n = 0;
    cm.operation(() => {
      const cur = cm.getSearchCursor(q.query, CodeMirror.Pos(cm.firstLine(), 0), { caseFold: q.fold });
      let m; while (n < 100000 && (m = cur.findNext())) { cur.replace(fbRepText(q, m)); n++; }
    });
    toast('Tümünü değiştir', n ? `${n} eşleşme değiştirildi` : 'Eşleşme yok');
    fbCount();
    return;
  }
  const from = cm.getCursor('from'), to = cm.getCursor('to');
  const cur = cm.getSearchCursor(q.query, from, { caseFold: q.fold });
  const m = cur.findNext();
  if (m && CodeMirror.cmpPos(cur.from(), from) === 0 && CodeMirror.cmpPos(cur.to(), to) === 0) cur.replace(fbRepText(q, m));
  imFindStep(false);
}

/* ---------- wiring ---------- */
function setupIdeMenu() {
  const cm = IDE.cm;
  const keys = {};
  for (const [k, v] of Object.entries(IM_KEYS)) keys[k] = typeof v === 'string' ? cm2 => cm2.execCommand(v) : v;
  cm.setOption('extraKeys', Object.assign({}, cm.getOption('extraKeys'), cmKeys(keys))); // Cmd- on macOS
  cm.setOption('highlightSelectionMatches', { minChars: 2, showToken: false, delay: 150, wordsOnly: true });
  cm.setOption('foldOptions', { widget: '\u2026', minFoldSize: 1 });
  imApplyUi();
  cm.on('swapDoc', () => { if (!$('#findBar').hidden) fbHighlight(); });
  cm.on('changes', () => { if ($('#findBar').hidden) return; clearTimeout(FB.timer); FB.timer = setTimeout(fbCount, 200); });

  imRenderBar();
  const bar = $('#imBar'), drop = $('#imDrop');
  bar.addEventListener('mousedown', e => { if (e.target.closest('[data-imb]')) e.preventDefault(); }); // keep the editor's focus to come back to
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-imb]'); if (!b) return;
    if (IM.open === b.dataset.imb) imClose(true); else imOpen(b.dataset.imb, e.detail === 0);
  });
  bar.addEventListener('mouseover', e => { const b = e.target.closest('[data-imb]'); if (b && IM.open && IM.open !== b.dataset.imb) imOpen(b.dataset.imb, false); });
  bar.addEventListener('keydown', e => {
    const b = e.target.closest('[data-imb]'); if (!b) return;
    const id = b.dataset.imb;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); imFocusBar(imShift(id, e.key === 'ArrowRight' ? 1 : -1)); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); imOpen(id, true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); imClose(true); }
    else if (e.key === 'Tab') imClose();
  });
  drop.addEventListener('click', e => { const b = e.target.closest('[data-imi]'); if (b && !b.disabled) imRun(+b.dataset.imi); });
  drop.addEventListener('mousemove', e => { const b = e.target.closest('[data-imi]'); if (b && !b.disabled && document.activeElement !== b) b.focus(); });
  drop.addEventListener('keydown', e => {
    const all = $$('#imDrop button:not(:disabled)'), i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = i < 0 ? all[e.key === 'ArrowDown' ? 0 : all.length - 1] : all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
      if (n) n.focus();
    } else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); const n = all[e.key === 'Home' ? 0 : all.length - 1]; if (n) n.focus(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); imOpen(imShift(IM.open, e.key === 'ArrowRight' ? 1 : -1), true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const id = IM.open; imClose(); imFocusBar(id); }
    else if (e.key === 'Tab') { e.preventDefault(); imClose(true); }
    else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); imRun(+all[i].dataset.imi); }
  });
  document.addEventListener('mousedown', e => { if (IM.open && !e.target.closest('#imDrop') && !e.target.closest('#imBar')) imClose(); }, true);
  window.addEventListener('blur', () => { imClose(); IM.armed = false; });
  // focus left the menus some other way (click elsewhere, Tab): forget where to return
  const left = () => setTimeout(() => {
    const a = document.activeElement;
    if (bar.contains(a) || drop.contains(a)) return;
    imClose(); IM.ret = null;
  });
  bar.addEventListener('focusout', left);
  drop.addEventListener('focusout', left);
  $('#itool').addEventListener('click', e => { const b = e.target.closest('[data-imcmd]'); if (b) imFind(b.dataset.imcmd === 'replace'); });
  // Alt alone (pressed and released with nothing else) moves to the menu strip, like Windows apps
  window.addEventListener('keydown', e => {
    IM.armed = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.repeat ? true : (e.key === 'Alt' && e.repeat ? IM.armed : false);
  }, true);
  window.addEventListener('mousedown', () => { IM.armed = false; }, true);
  window.addEventListener('keyup', e => {
    if (e.key !== 'Alt' || !IM.armed) return;
    IM.armed = false;
    if (!ideKeysOk(e) || !$('#qoBg').hidden) return;
    e.preventDefault();
    if (IM.open || $('#imBar').contains(document.activeElement)) imClose(true); else imFocusBar();
  }, true);

  // find bar
  const fi = $('#fbFind'), ri = $('#fbRep');
  fi.addEventListener('input', () => { clearTimeout(FB.timer); FB.timer = setTimeout(fbHighlight, 80); });
  fi.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (modKey(e) && e.altKey) fbReplace(true); else imFindStep(e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fbClose(); }
  });
  ri.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); fbReplace(modKey(e) && e.altKey); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fbClose(); }
  });
  $('#fbTog').addEventListener('click', () => { fbShowRep(!FB.rep); (FB.rep ? ri : fi).focus(); });
  $('#findBar').addEventListener('click', e => {
    const o = e.target.closest('[data-fbopt]');
    if (o) { const k = o.dataset.fbopt; FB[k] = !FB[k]; o.setAttribute('aria-pressed', FB[k]); fbHighlight(); fi.focus(); return; }
    const b = e.target.closest('[data-fb]'); if (!b) return;
    const a = b.dataset.fb;
    if (a === 'next' || a === 'prev') imFindStep(a === 'prev');
    else if (a === 'close') fbClose();
    else if (a === 'one') fbReplace(false);
    else if (a === 'all') fbReplace(true);
  });
}
