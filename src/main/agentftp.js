// VoxStorm — the FTP / FTPS / SFTP deployment servers of the IDE (ftp.js) for Claude and Codex.
// Like SSH and databases: the agent sees ids, names and paths only; host, user and password stay here.
// First use of a server in a session asks the user (authorize); a delete is asked about every time.
const path = require('path');
const fs = require('fs');
const I18N = require('../i18n/i18n.js'); const __ = I18N.t;

module.exports = function agentFtp({ getFtp, authorize, sessionInfo, showBox, clip, MAX_TEXT }) {
  const F = () => getFtp().agent;
  const str = d => ({ type: 'string', description: d });
  const S = (description, props, required) => ({ description, inputSchema: { type: 'object', properties: props, required, additionalProperties: false } });
  const CONN = str(__('list_connections’taki FTP sunucusunun id’si ya da adı'));
  const RPATH = __('Uzak yol: “/” ile başlıyorsa mutlak, yoksa sunucunun kök klasörüne göre');
  const tools = () => [
    ['ftp_list', S(__('VoxStorm’da kayıtlı bir FTP / FTPS / SFTP sunucusunda bir klasörün içeriğini listeler (ad, tür, boyut, değiştirilme zamanı).'), { connection: CONN, path: str(RPATH + __(' (boş: kök klasör)')) }, ['connection'])],
    ['ftp_read', S(__('FTP sunucusundaki bir metin dosyasını okur (en çok 2 MB).'), { connection: CONN, path: str(RPATH) }, ['connection', 'path'])],
    ['ftp_write', S(__('FTP sunucusuna bir metin dosyası yazar (varsa üzerine yazar, klasörleri gerekirse oluşturur).'), { connection: CONN, path: str(RPATH), content: str(__('Dosyanın yeni içeriği')) }, ['connection', 'path', 'content'])],
    ['ftp_upload', S(__('Bu bilgisayardaki bir dosyayı FTP sunucusuna yükler.'), { connection: CONN, local_path: str(__('Yerel dosyanın tam yolu')), remote_path: str(RPATH) }, ['connection', 'local_path', 'remote_path'])],
    ['ftp_download', S(__('FTP sunucusundaki bir dosyayı bu bilgisayara indirir.'), { connection: CONN, remote_path: str(RPATH), local_path: str(__('Yereldeki hedef yol (tam yol, dosya adıyla)')) }, ['connection', 'remote_path', 'local_path'])],
    ['ftp_delete', S(__('FTP sunucusunda bir dosyayı ya da klasörü (içindekilerle) siler. Her silme kullanıcıya ayrıca sorulur.'), { connection: CONN, path: str(RPATH) }, ['connection', 'path'])],
    ['ftp_mkdir', S(__('FTP sunucusunda klasör oluşturur (ara klasörlerle).'), { connection: CONN, path: str(RPATH) }, ['connection', 'path'])],
    ['ftp_rename', S(__('FTP sunucusunda bir dosyayı ya da klasörü taşır / yeniden adlandırır.'), { connection: CONN, from: str(RPATH), to: str(RPATH) }, ['connection', 'from', 'to'])],
    ['deploy_upload', S(__('Projenin dosyalarını, IDE’deki deployment ayarına göre (varsayılan sunucu ve eşleme) sunucuya yükler; PhpStorm’daki “Upload to” gibi. Uzak yolu VoxStorm eşlemeden bulur. Proje için deployment ayarı yoksa hata döner.'), {
      files: { type: 'array', items: { type: 'string' }, description: __('Yüklenecek dosyalar (tam yol ya da projeye göre yol)') },
    }, ['files'])],
  ].map(([name, def]) => ({ name, ...def }));

  function find(ref) {
    const r = String(ref || '').trim(), lower = r.toLocaleLowerCase('tr');
    const list = F().list();
    const x = list.find(c => c.id === r) || list.find(c => c.name.toLocaleLowerCase('tr') === lower);
    if (!x) throw new Error(__('“{name}” adında bir FTP sunucusu bulunamadı. list_connections ile kayıtlı bağlantılara bak.', { name: r }));
    return x;
  }
  async function use(a, ptyId, what) {
    const s = find(a.connection);
    if (!(await authorize('ftp', s, ptyId, what))) throw new Error(__('Kullanıcı “{name}” sunucusunun kullanılmasına izin vermedi.', { name: s.name }));
    return s;
  }
  const when = ms => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');
  const H = {
    async ftp_list(a, ptyId) {
      const s = await use(a, ptyId, __('Listele: {path}', { path: a.path || '/' }));
      const p = F().resolvePath(s.id, a.path || '');
      const l = await F().ls(s.id, a.path || '');
      l.sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name) : x.dir ? -1 : 1));
      return [p + ` (${l.length})`, ...l.map(f => `${f.dir ? 'd' : f.link ? 'l' : '-'}\t${f.dir ? '' : f.size}\t${when(f.mtime)}\t${f.name}${f.dir ? '/' : ''}`)].join('\n');
    },
    async ftp_read(a, ptyId) {
      const s = await use(a, ptyId, __('Oku: {path}', { path: a.path }));
      const buf = await F().read(s.id, a.path);
      if (buf.subarray(0, 8000).includes(0)) throw new Error(__('İkili (binary) dosya, metin olarak açılamaz.'));
      return clip(buf.toString('utf8'), MAX_TEXT);
    },
    async ftp_write(a, ptyId) {
      const s = await use(a, ptyId, __('Yaz: {path}', { path: a.path }));
      const rp = await F().write(s.id, a.path, String(a.content == null ? '' : a.content));
      return __('Yazıldı: {path}', { path: rp });
    },
    async ftp_upload(a, ptyId) {
      const local = String(a.local_path || '');
      if (!path.isAbsolute(local)) throw new Error(__('local_path tam yol olmalı.'));
      if (!fs.existsSync(local)) throw new Error(__('Yerel dosya bulunamadı: {path}', { path: local }));
      const s = await use(a, ptyId, __('Yükleme: {from} → {to}', { from: local, to: a.remote_path }));
      return __('Yüklendi: {path}', { path: await F().put(s.id, local, a.remote_path) });
    },
    async ftp_download(a, ptyId) {
      const local = String(a.local_path || '');
      if (!path.isAbsolute(local)) throw new Error(__('local_path tam yol olmalı.'));
      const s = await use(a, ptyId, __('İndirme: {from} → {to}', { from: a.remote_path, to: local }));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      await F().get(s.id, a.remote_path, local);
      return __('İndirildi: {path}', { path: local });
    },
    async ftp_delete(a, ptyId) {
      const s = await use(a, ptyId, __('Sil: {path}', { path: a.path }));
      const rp = F().resolvePath(s.id, a.path);
      const info = sessionInfo(ptyId);
      const r = await showBox(info, {
        title: __('{agent} onay istiyor', { agent: info.agent }), danger: true,
        message: __('{agent}, “{name}” sunucusunda bir dosyayı ya da klasörü silmek istiyor.', { agent: info.agent, name: s.name }),
        code: rp, ok: __('Sil'), cancel: __('Vazgeç'),
      });
      if (!r.ok) throw new Error(__('Kullanıcı silmeye izin vermedi.'));
      return __('Silindi: {path}', { path: await F().remove(s.id, a.path) });
    },
    async ftp_mkdir(a, ptyId) {
      const s = await use(a, ptyId, __('Klasör oluştur: {path}', { path: a.path }));
      return __('Oluşturuldu: {path}', { path: await F().mkdir(s.id, a.path) });
    },
    async ftp_rename(a, ptyId) {
      const s = await use(a, ptyId, __('Taşı: {from} → {to}', { from: a.from, to: a.to }));
      const [x, y] = await F().rename(s.id, a.from, a.to);
      return __('Taşındı: {from} → {to}', { from: x, to: y });
    },
    async deploy_upload(a, ptyId) {
      const info = sessionInfo(ptyId);
      if (!info.cwd) throw new Error(__('Oturumun proje klasörü bilinmiyor.'));
      const root = info.cwd, d = F().deployOf(root);
      if (!d) throw new Error(__('Bu proje için deployment ayarı yok. Kullanıcının IDE’de Deployment panelinden bir sunucu ve eşleme seçmesi gerekiyor.'));
      const s = F().list().find(x => x.id === d.server);
      if (!s) throw new Error(__('Projenin deployment sunucusu ajanlara kapalı ya da silinmiş.'));
      const files = (Array.isArray(a.files) ? a.files : []).map(f => path.resolve(root, String(f)));
      if (!files.length) throw new Error(__('Dosya listesi boş.'));
      if (!(await authorize('ftp', s, ptyId, __('Yükle:') + '\n' + files.map(f => path.relative(root, f)).join('\n')))) throw new Error(__('Kullanıcı “{name}” sunucusunun kullanılmasına izin vermedi.', { name: s.name }));
      const out = [];
      for (const f of files) {
        try { out.push('✓ ' + path.relative(root, f) + ' → ' + await F().upload(root, f, s.id)); } catch (e) { out.push('✗ ' + path.relative(root, f) + ': ' + e.message); }
      }
      return { text: out.join('\n'), isError: out.some(x => x.startsWith('✗')) };
    },
  };
  return {
    tools,
    has: name => Object.prototype.hasOwnProperty.call(H, name),
    call: (name, a, ptyId) => H[name](a || {}, ptyId),
    // for list_connections
    list: ptyId => {
      const info = sessionInfo(ptyId), d = info.cwd ? F().deployOf(info.cwd) : null;
      const note = c => (c.aiAccess === 'allow' ? __('izinli') : __('ilk kullanımda sorulur'));
      const list = F().list().map(c => ({ id: c.id, name: c.name, type: c.type, group: c.group || undefined, root: F().root(c.id), access: note(c), deployDefault: d && d.server === c.id ? true : undefined }));
      return list;
    },
  };
};
