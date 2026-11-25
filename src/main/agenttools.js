// VoxStorm — the workspace tools Claude Code and Codex sessions get through VoxStorm's MCP server
// (agentlink.js serves them next to the SSH / DB tools). Most of them act in a window: the main process
// calls window.agentApi.<fn> there (src/renderer/agentapi.js) and returns its answer. Anything that asks
// the user does so in VoxStorm's own dialogs, never in a system message box.
const path = require('path');
const fs = require('fs');
const I18N = require('../i18n/i18n.js'); const __ = I18N.t;

const S = (description, properties = {}, required = []) => ({ description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const str = d => ({ type: 'string', description: d });
const num = d => ({ type: 'number', description: d });
const bool = d => ({ type: 'boolean', description: d });

// built on each call: the descriptions follow the interface language
const tools = () => [
  ['show_file', S(__('Bir dosyayı kullanıcının önüne getirir: VoxStorm penceresi öne gelir, IDE moduna geçer, dosya soldaki dosya ağacında senin adınla yanıp sönerek işaretlenir ve (open_tab false değilse) editörde sekme olarak açılır, istenirse bir satıra gidilir. Kullanıcı bir dosyanın nerede olduğunu sorduğunda, bir dosyayı görmek istediğinde ya da değiştirdiğin bir yeri göstermek istediğinde kullan. Dosya VoxStorm’a eklenmiş projelerden birinin içinde olmalı. Göreli yol oturumun klasörüne göre çözülür.'), {
    path: str(__('Dosyanın tam yolu ya da oturum klasörüne göre göreli yolu')),
    line: num(__('İsteğe bağlı: gidilecek satır (1’den başlar)')),
    open_tab: bool(__('Varsayılan true: dosya editörde sekme olarak da açılır. false: yalnızca dosya ağacında yeri gösterilir (işaretlenir).')),
  }, ['path'])],
  ['highlight_lines', S(__('Bir dosyada bir ya da birkaç satır aralığını VoxStorm IDE’de renkli işaretler ve her aralığın altına senin notunu yazar (kod incelemesi gibi: "şu üç yere bak"). Bir önceki işaretleme kalkar; kullanıcı notlardaki × ile de kaldırabilir. Dosya bir proje içinde olmalı.'), {
    path: str(__('Dosyanın tam yolu ya da oturum klasörüne göre göreli yolu')),
    ranges: { type: 'array', description: __('İşaretlenecek yerler (en çok 30)'), items: { type: 'object', properties: { line: num(__('Başlangıç satırı (1’den başlar)')), end_line: num(__('İsteğe bağlı: bitiş satırı')), note: str(__('İsteğe bağlı: bu yer için kısa not')) }, required: ['line'], additionalProperties: false } },
  }, ['path', 'ranges'])],
  ['get_editor_state', S(__('VoxStorm IDE’de kullanıcının o an baktığı şeyi döndürür: proje, açık dosya, imlecin satırı/sütunu, seçili metin, açık sekmeler ve kaydedilmemiş dosyalar. Kullanıcı "şuna bak", "seçtiğim yer" dediğinde ya da bir dosyayı değiştirmeden önce (kaydedilmemiş değişikliklerin üstüne yazmamak için) kullan.'))],
  ['show_diff', S(__('VoxStorm’un git penceresini açar ve projedeki değişiklikleri gösterir; path verilirse o dosyanın farkı seçili gelir. ask true ise farkın üstünde "Kabul et / Geri al" çubuğu çıkar ve kullanıcının cevabını beklersin (accepted / rejected / dismissed). rejected gelirse değişikliği geri almak senin işin.'), {
    path: str(__('İsteğe bağlı: farkı gösterilecek dosya (tam ya da göreli yol)')),
    ask: bool(__('true: kullanıcıya kabul / geri al diye sor ve cevabı bekle')),
    message: str(__('İsteğe bağlı: çubukta görünecek kısa soru / açıklama')),
  })],
  ['ask_user', S(__('Kullanıcıya VoxStorm’un kendi penceresinde soru sorar ve cevabı bekler (pencere arkadaysa öne gelir, bildirim gider). Seçenek verirsen kullanıcı birini (multi ile birkaçını) seçer; allow_text ile kendi cevabını da yazabilir. Seçenek yoksa yazılı cevap ister; allow_text false ise Evet / Hayır sorar. Kullanıcı cevap vermeden kapatırsa answered false döner.'), {
    question: str(__('Soru')),
    detail: str(__('İsteğe bağlı: açıklama')),
    options: { type: 'array', description: __('İsteğe bağlı: seçenekler (en çok 12)'), items: { type: 'object', properties: { label: str(__('Seçenek')), description: str(__('İsteğe bağlı: kısa açıklama')) }, required: ['label'], additionalProperties: false } },
    multi: bool(__('true: birden fazla seçenek seçilebilir')),
    allow_text: bool(__('Seçeneklerle birlikte serbest metin kutusu da göster (seçenek yoksa false: Evet / Hayır sorusu)')),
  }, ['question'])],
  ['notify_user', S(__('Kullanıcıya masaüstü bildirimi gönderir (ör. "APK hazır", "testler geçti"); bildirime tıklanınca VoxStorm bu oturumun sekmesine gider. Uzun süren bir iş bittiğinde ya da kullanıcının dikkati gerektiğinde kullan; her küçük adımda kullanma.'), {
    title: str(__('Kısa başlık')), message: str(__('İsteğe bağlı: bir iki cümlelik açıklama')),
  }, ['title'])],
  ['list_terminals', S(__('VoxStorm’da açık terminal sekmelerini listeler: Claude / Codex oturumları ve kabuk terminalleri (id, başlık, proje, durum). Senin kendi sekmen "you": true ile işaretlidir.'))],
  ['read_terminal', S(__('VoxStorm’daki bir terminal sekmesinin son satırlarını okur (ör. kullanıcının çalıştırdığı sunucunun hatası, başka bir oturumun çıktısı).'), {
    terminal: str(__('list_terminals’taki id ya da başlık')), lines: num(__('Son kaç satır (varsayılan 200, en çok 3000)')),
  }, ['terminal'])],
  ['run_in_terminal', S(__('Bir komutu VoxStorm’da görünür yeni bir terminal sekmesinde başlatır (npm run dev, gradlew assembleDebug, docker compose up…). Kullanıcı çıktıyı canlı izler; sen read_terminal ile okursun. Uzun süren ya da kullanıcının görmesi gereken işler için kendi kabuğun yerine bunu kullan. Terminal projenin klasöründe açılır.'), {
    command: str(__('Çalışacak komut')), title: str(__('İsteğe bağlı: sekme başlığı')), cwd: str(__('İsteğe bağlı: proje klasörü (varsayılan: bu oturumun projesi)')),
  }, ['command'])],
  ['send_to_session', S(__('VoxStorm’da açık başka bir Claude / Codex oturumuna mesaj gönderir (o oturuma kullanıcı yazmış gibi). İki oturum birlikte çalışırken (ör. biri backend, biri frontend) haberleşmek için. İlk seferde kullanıcıdan onay istenir.'), {
    target: str(__('list_terminals’taki id ya da başlık')), message: str(__('Gönderilecek mesaj')),
  }, ['target', 'message'])],
  ['docker_list', S(__('Bu bilgisayardaki Docker konteynerlerini listeler (ad, imaj, durum, portlar, compose projesi).'))],
  ['docker_logs', S(__('Bu bilgisayardaki bir Docker konteynerinin son loglarını döndürür.'), {
    container: str(__('Konteyner adı ya da kimliği')), tail: num(__('Son kaç satır (varsayılan 200, en çok 5000)')),
  }, ['container'])],
  ['docker_action', S(__('Bu bilgisayardaki bir Docker konteynerini başlatır, durdurur ya da yeniden başlatır. Kullanıcıya onay sorulur.'), {
    container: str(__('Konteyner adı ya da kimliği')), action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'start | stop | restart' },
  }, ['container', 'action'])],
  ['list_plugin_tools', S(__('VoxStorm eklentilerinin sana sunduğu araçları listeler (eklenti kimliği, araç adı, açıklama, parametre şeması). call_plugin_tool ile çağrılır.'))],
  ['call_plugin_tool', S(__('Bir VoxStorm eklentisinin aracını çağırır ve sonucunu döndürür.'), {
    plugin: str(__('Eklenti kimliği (list_plugin_tools’taki "plugin")')), tool: str(__('Araç adı')), args: { type: 'object', description: __('Aracın parametreleri') },
  }, ['plugin', 'tool'])],
  ['get_theme', S(__('VoxStorm’un şu anki arayüz temasını (on temel renk, koyu/açık, pencere ve panel resimleri, terminal renkleri), renk alanlarının ne işe yaradığını ve kullanıcının özel temalarını döndürür. save_theme’den önce bak.'))],
  ['save_theme', S(__('VoxStorm için yeni bir arayüz teması kaydeder ve hemen uygular (kullanıcı Tema menüsünden geri dönebilir ya da düzenleyebilir). On temel renk verilir (#rrggbb); ara tonları VoxStorm hesaplar. Yazı ile zemin arasında okunur kontrast bırak. İstersen yerel bir resmi tüm pencerenin (image_path) ya da yalnızca yan panellerin, terminalin, kod editörünün (panel_images) arka planı yapabilirsin; Claude Code konsolunun yazı renkleri için term_colors ve ansi.'), {
    name: str(__('Temanın adı')),
    dark: bool(__('Koyu tema mı (false: açık)')),
    colors: { type: 'object', description: __('Renkler: bg, surface, fg, muted, accent, warn, ok, danger, termBg, termFg (hepsi #rrggbb). Verilmeyenler varsayılan koyu temadan gelir.'), properties: Object.fromEntries(['bg', 'surface', 'fg', 'muted', 'accent', 'warn', 'ok', 'danger', 'termBg', 'termFg'].map(k => [k, { type: 'string' }])), additionalProperties: false },
    image_path: str(__('İsteğe bağlı: arka plan resmi olacak yerel dosyanın tam yolu (png, jpg, webp…)')),
    image_show: num(__('Resmin görünürlüğü, yüzde (5–90, varsayılan 35)')),
    image_blur: num(__('Resmin bulanıklığı, piksel (0–30, varsayılan 0)')),
    panel_images: { type: 'object', description: __('İsteğe bağlı: yalnızca bir panelin arkasına resim. Anahtarlar: side (yan paneller), term (terminal), editor (kod editörü); her biri { path: yerel tam yol, show: 5–90, blur: 0–30 }. Tüm pencere resminden (image_path) bağımsızdır.'), additionalProperties: false,
      properties: Object.fromEntries(['side', 'term', 'editor'].map(k => [k, { type: ['object', 'null'], properties: { path: { type: 'string' }, show: { type: 'number' }, blur: { type: 'number' } } }])) },
    term_colors: { type: 'string', enum: ['theme', 'windows'], description: __('Terminal yazı renkleri: "theme" — Claude Code konsolu termFg ve ansi renklerini kullanır; "windows" — Windows Terminal renkleri (termFg ve ansi kullanılmaz). Konsol yazı rengini değiştirmek istiyorsan "theme" ver.') },
    ansi: { type: 'object', description: __('İsteğe bağlı: terminalin 16 rengi (#rrggbb): black, red, green, yellow, blue, magenta, cyan, white ve bright… sürümleri. Yalnızca term_colors "theme" iken kullanılır.'), additionalProperties: false,
      properties: Object.fromEntries(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'].map(k => [k, { type: 'string' }])) },
  }, ['name', 'colors'])],
  // these need the "SSH / DB for agents" setting (served with the SSH / DB tools)
  ['show_query', S(__('Bir SQL sorgusunu VoxStorm’un DB modunda, kullanıcının önünde bir sorgu sekmesinde açar; salt okunur bir sorguysa (SELECT, WITH, SHOW…) hemen çalıştırır ve sonuç tablo olarak görünür, değilse çalıştırmayı kullanıcıya bırakır. Kullanıcıya bir sonucu göstermek istediğinde db_query yerine bunu kullan.'), {
    connection: str(__('list_connections’taki id ya da ad')), sql: str(__('Sorgu')), database: str(__('İsteğe bağlı: veritabanı')),
  }, ['connection', 'sql']), 'link'],
  ['ssh_upload', S(__('Bu bilgisayardaki bir dosyayı VoxStorm’da kayıtlı bir SSH sunucusuna SFTP ile kopyalar.'), {
    connection: str(__('list_connections’taki id ya da ad')), local_path: str(__('Yerel dosyanın tam yolu')), remote_path: str(__('Sunucudaki hedef yol (dosya adıyla)')),
  }, ['connection', 'local_path', 'remote_path']), 'link'],
  ['ssh_download', S(__('VoxStorm’da kayıtlı bir SSH sunucusundaki bir dosyayı SFTP ile bu bilgisayara indirir.'), {
    connection: str(__('list_connections’taki id ya da ad')), remote_path: str(__('Sunucudaki dosyanın yolu')), local_path: str(__('Yereldeki hedef yol (tam yol, dosya adıyla)')),
  }, ['connection', 'remote_path', 'local_path']), 'link'],
].map(([name, def, group]) => ({ name, group: group || 'work', ...def }));

module.exports = function agentTools({ sessionInfo, winFor, notify, notifyTab, getDocker, getThemes, getSsh, getDb, find, authorize, askOnce, clip }) {
  // a call into window.agentApi; front: bring the window forward, attention: flash and notify instead
  async function ui(win, fn, args, { front = false, attention = false, title = '' } = {}) {
    const w = win && !win.isDestroyed() ? win : null;
    if (!w) throw new Error(__('VoxStorm penceresi açık değil.'));
    if (front || attention) { if (!w.isVisible()) w.show(); if (w.isMinimized()) w.restore(); }
    if (front) w.focus();
    if (attention) { w.flashFrame(true); if (!w.isFocused()) notify(title || 'VoxStorm', String(args.question || '')); }
    const wc = w.webContents;
    try {
      if (wc.isLoading()) await new Promise(r => wc.once('did-finish-load', r));
      const r = await wc.executeJavaScript(`window.agentApi[${JSON.stringify(fn)}](${JSON.stringify(args)})`, true);
      if (r && r.error) throw new Error(r.error);
      return r;
    } finally { if (attention && !w.isDestroyed()) w.flashFrame(false); }
  }
  const json = o => JSON.stringify(o, null, 1);
  function filePath(info, p) {
    let fp = String(p || '').trim().replace(/^file:\/\/\/?/i, '');
    if (!fp) throw new Error(__('Dosya yolu boş.'));
    if (!path.isAbsolute(fp)) { if (!info.cwd) throw new Error(__('Göreli yol çözülemedi; tam yolu ver.')); fp = path.resolve(info.cwd, fp); }
    return path.normalize(fp);
  }
  const callerWin = info => info.win;

  const H = {
    async show_file(a, info) {
      const fp = filePath(info, a.path);
      const r = await ui(winFor('ide'), 'showFile', { path: fp, line: Math.max(0, Math.floor(Number(a.line) || 0)), openTab: a.open_tab !== false, by: info.agent }, { front: true });
      const msg = a.open_tab === false
        ? __('Dosya VoxStorm IDE’de dosya ağacında gösterildi (proje: {project}): {path}', { project: r.project, path: fp })
        : __('Dosya VoxStorm IDE’de açıldı (proje: {project}): {path}', { project: r.project, path: fp });
      return msg + (a.line ? __(' · satır {line}', { line: Math.floor(Number(a.line)) }) : '');
    },
    async highlight_lines(a, info) {
      const fp = filePath(info, a.path);
      const r = await ui(winFor('ide'), 'highlight', { path: fp, ranges: a.ranges, by: info.agent }, { front: true });
      return __('{n} yer işaretlendi: {path}', { n: r.marked, path: fp });
    },
    async get_editor_state() { return json(await ui(winFor('ide'), 'editorState', {})); },
    async show_diff(a, info) {
      const r = await ui(callerWin(info), 'showDiff', { path: a.path ? filePath(info, a.path) : '', cwd: info.cwd, ask: !!a.ask, message: a.message ? String(a.message).slice(0, 300) : '', by: info.agent }, { front: true });
      if (a.ask) return { accepted: __('Kullanıcı değişiklikleri KABUL ETTİ.'), rejected: __('Kullanıcı değişiklikleri REDDETTİ: geri al.'), dismissed: __('Kullanıcı cevap vermeden kapattı.') }[r.answer] || json(r);
      return r.note ? __('Git penceresi açıldı: {note}', { note: r.note }) : __('Git penceresi açıldı.');
    },
    async ask_user(a, info) {
      const r = await ui(callerWin(info), 'askUser', {
        question: a.question, detail: a.detail, options: a.options, multi: !!a.multi, allowText: a.allow_text, by: info.agent, project: info.project,
      }, { attention: true, title: __('{agent} soruyor', { agent: info.agent }) });
      return json(r);
    },
    async notify_user(a, info, ptyId) {
      notifyTab(clip(a.title, 120) || info.agent, clip(a.message, 400), ptyId);
      return __('Bildirim gönderildi.');
    },
    async list_terminals(a, info, ptyId) { return json(await ui(callerWin(info), 'listTerminals', { from: ptyId })); },
    async read_terminal(a, info) {
      const r = await ui(callerWin(info), 'readTerminal', { terminal: a.terminal, lines: a.lines });
      return `# ${r.terminal.title} (${r.terminal.kind}${r.terminal.project ? ', ' + r.terminal.project : ''})\n` + clip(r.text, 100 * 1024);
    },
    async run_in_terminal(a, info, ptyId) {
      if (!String(a.command || '').trim()) throw new Error(__('Komut boş.'));
      const r = await ui(callerWin(info), 'runInTerminal', { command: String(a.command), title: a.title, cwd: a.cwd || info.cwd, from: ptyId, by: info.agent });
      return __('Komut “{title}” sekmesinde başladı (id: {id}). Çıktı için read_terminal kullan.', { title: r.terminal.title, id: r.terminal.id });
    },
    async send_to_session(a, info, ptyId) {
      const r = await ui(callerWin(info), 'sendToSession', { target: a.target, message: a.message, from: ptyId, by: info.agent });
      return __('Mesaj “{title}” oturumuna gönderildi.', { title: r.sentTo.title });
    },
    async docker_list() {
      const r = await getDocker().agent.containers();
      if (r.error) throw new Error(r.error);
      return json(r.items.map(c => ({ name: c.name, id: c.id, image: c.image, state: c.state, status: c.status, ports: c.ports || undefined, compose: c.project ? c.project + '/' + c.service : undefined })));
    },
    async docker_logs(a) {
      const r = await getDocker().agent.logs(String(a.container || ''), a.tail);
      if (r.error) throw new Error(r.error);
      return clip(r.text || __('(log yok)'), 100 * 1024);
    },
    async docker_action(a, info, ptyId) {
      const id = String(a.container || ''), act = String(a.action || '');
      const vars = { agent: info.agent, name: id };
      const message = {
        start: () => __('{agent}, “{name}” konteynerini başlatmak istiyor.', vars),
        stop: () => __('{agent}, “{name}” konteynerini durdurmak istiyor.', vars),
        restart: () => __('{agent}, “{name}” konteynerini yeniden başlatmak istiyor.', vars),
      }[act];
      if (!message) throw new Error(__('Geçersiz işlem.'));
      const ok = await askOnce(ptyId, 'docker:' + act + ':' + id, {
        title: __('{agent} onay istiyor', { agent: info.agent }), icon: 'fa-cube', message: message(),
        detail: __('Oturum: {agent} · {project}', { agent: info.agent, project: info.project }), ok: __('İzin ver'), cancel: __('Hayır'),
      });
      if (!ok) throw new Error(__('Kullanıcı izin vermedi.'));
      const r = await getDocker().agent.action(id, act);
      if (r.error) throw new Error(r.error);
      return __('“{name}”: {action} tamam.', { name: id, action: act });
    },
    async list_plugin_tools() {
      const list = await ui(winFor('main'), 'pluginTools', {});
      return list.length ? json(list) : __('Araç sunan bir eklenti yok.');
    },
    async call_plugin_tool(a) {
      const r = await ui(winFor('main'), 'callPluginTool', { plugin: a.plugin, tool: a.tool, args: a.args || {} });
      return typeof r.result === 'string' ? r.result : json(r.result);
    },
    async get_theme() { return json(await ui(winFor('main'), 'getTheme', {})); },
    async save_theme(a, info) {
      let image = null;
      if (a.image_path) { const im = getThemes().importImage(String(a.image_path)); image = { url: im.url, file: im.file, show: a.image_show || 35, blur: a.image_blur || 0 }; }
      let panels;
      if (a.panel_images && typeof a.panel_images === 'object') {
        panels = {};
        for (const k of ['side', 'term', 'editor']) {
          const p = a.panel_images[k];
          if (p && p.path) { const im = getThemes().importImage(String(p.path)); panels[k] = { url: im.url, file: im.file, show: p.show || 35, blur: p.blur || 0 }; }
        }
      }
      const r = await ui(winFor('main'), 'saveTheme', { name: a.name, dark: a.dark, colors: a.colors, image, panels, ansi: a.ansi, termColors: a.term_colors, by: info.agent }, { front: true });
      return __('“{name}” teması kaydedildi ve uygulandı (custom:{id}).', { name: r.name, id: r.id });
    },
    async show_query(a, info, ptyId) {
      const c = find(getDb().agentList(), a.connection, 'db');
      const sql = String(a.sql || '');
      if (!sql.trim()) throw new Error(__('Sorgu boş.'));
      if (!(await authorize('db', c, ptyId, sql))) throw new Error(__('Kullanıcı “{name}” bağlantısının kullanılmasına izin vermedi.', { name: c.name }));
      const r = await ui(winFor('db'), 'showQuery', { connId: c.id, sql, database: a.database ? String(a.database) : '' }, { front: true });
      return r.ran ? __('Sorgu DB modunda açıldı ve çalıştırıldı; sonuç kullanıcının önünde.') : r.note;
    },
    async ssh_upload(a, info, ptyId) { return sftp('put', a, info, ptyId); },
    async ssh_download(a, info, ptyId) { return sftp('get', a, info, ptyId); },
  };
  async function sftp(op, a, info, ptyId) {
    const h = find(getSsh().agentList(), a.connection, 'ssh');
    const local = String(a.local_path || ''), remote = String(a.remote_path || '');
    if (!path.isAbsolute(local)) throw new Error(__('local_path tam yol olmalı.'));
    if (!remote.trim()) throw new Error(__('remote_path boş.'));
    if (op === 'put' && !fs.existsSync(local)) throw new Error(__('Yerel dosya bulunamadı: {path}', { path: local }));
    const what = op === 'put' ? __('Yükleme: {from} → {to}', { from: local, to: remote }) : __('İndirme: {from} → {to}', { from: remote, to: local });
    if (!(await authorize('ssh', h, ptyId, what))) throw new Error(__('Kullanıcı “{name}” sunucusunun kullanılmasına izin vermedi.', { name: h.name }));
    if (op === 'get') fs.mkdirSync(path.dirname(local), { recursive: true });
    await getSsh().agentSftp(h.id, op, local, remote);
    return op === 'put' ? __('Yüklendi: {path}', { path: remote }) : __('İndirildi: {path}', { path: local });
  }

  return {
    tools: linkOn => tools().filter(t => linkOn || t.group !== 'link').map(({ group, ...t }) => t),
    has: name => Object.prototype.hasOwnProperty.call(H, name),
    needsLink: name => (tools().find(t => t.name === name) || {}).group === 'link',
    call: (name, a, ptyId) => H[name](a || {}, sessionInfo(ptyId), ptyId),
  };
};
