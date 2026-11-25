// VoxStorm — background images of custom themes. A chosen picture is copied into <userData>/themes so the
// theme keeps working when the original moves; the window shows it through a file:// URL (img-src allows it).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const I18N = require('../i18n/i18n.js'); const __ = I18N.t;

const EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'];
const MAX = 25 * 1024 * 1024;

module.exports = function registerThemes({ ipcMain, dialog, BrowserWindow, DATA }) {
  const DIR = path.join(DATA, 'themes');

  function importImage(src) {
    src = String(src || '');
    if (!path.isAbsolute(src)) throw new Error(__('Resim yolu tam yol olmalı.'));
    const ext = path.extname(src).toLowerCase();
    if (!EXT.includes(ext)) throw new Error(__('Desteklenen resim türleri: {list}', { list: EXT.join(', ') }));
    const st = fs.statSync(src);
    if (!st.isFile()) throw new Error(__('Resim bulunamadı: {path}', { path: src }));
    if (st.size > MAX) throw new Error(__('Resim 25 MB’tan büyük olamaz.'));
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, crypto.randomBytes(8).toString('hex') + ext);
    fs.copyFileSync(src, file);
    return { file, url: pathToFileURL(file).href };
  }
  // only files inside <userData>/themes are ever deleted
  function removeImage(file) {
    file = path.resolve(String(file || ''));
    if (path.dirname(file) !== DIR) return false;
    try { fs.unlinkSync(file); return true; } catch (_) { return false; }
  }

  ipcMain.handle('theme:pickImage', async e => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w, { title: __('Arka plan resmi seç'), properties: ['openFile'], filters: [{ name: __('Resimler'), extensions: EXT.map(x => x.slice(1)) }] });
    if (r.canceled || !r.filePaths[0]) return null;
    try { return importImage(r.filePaths[0]); } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('theme:removeImage', (_e, file) => removeImage(file));

  /* sharing: a .voxtheme file is JSON with the colours and the pictures inlined (base64), so it works on
     another computer. Only pictures inside <userData>/themes are read; colours are checked again by the
     renderer (themes.js clean) when the file is imported. */
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
  const FILE_MAX = 120 * 1024 * 1024;
  const SLOTS = ['side', 'term', 'editor'];
  function packPic(p) {
    if (!p || !p.file) return null;
    const file = path.resolve(String(p.file));
    if (path.dirname(file) !== DIR) return null;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime || !fs.existsSync(file)) return null;
    return { show: p.show, blur: p.blur, data: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
  }
  function unpackPic(p) {
    if (!p || typeof p.data !== 'string') return null;
    const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(p.data);
    if (!m) return null;
    const ext = Object.keys(MIME).find(e => MIME[e] === m[1]);
    if (!ext) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX) throw new Error(__('Resim 25 MB’tan büyük olamaz.'));
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, crypto.randomBytes(8).toString('hex') + ext);
    fs.writeFileSync(file, buf);
    return { file, url: pathToFileURL(file).href, show: +p.show || 35, blur: +p.blur || 0 };
  }
  ipcMain.handle('theme:export', async (e, th) => {
    try {
      th = th && typeof th === 'object' ? th : {};
      const w = BrowserWindow.fromWebContents(e.sender);
      const safe = String(th.name || 'tema').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 40) || 'tema';
      const r = await dialog.showSaveDialog(w, { title: __('Temayı paylaş'), defaultPath: safe + '.voxtheme', filters: [{ name: __('VoxStorm teması'), extensions: ['voxtheme'] }] });
      if (r.canceled || !r.filePath) return null;
      const panels = {};
      for (const k of SLOTS) { const p = packPic(th.panels && th.panels[k]); if (p) panels[k] = p; }
      const out = { voxtheme: 1, name: String(th.name || ''), dark: !!th.dark, colors: th.colors || {}, popup: +th.popup || 100, ansi: th.ansi || undefined, image: packPic(th.image) || undefined, panels: Object.keys(panels).length ? panels : undefined };
      fs.writeFileSync(r.filePath, JSON.stringify(out));
      return { path: r.filePath };
    } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('theme:import', async e => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w, { title: __('Tema içe aktar'), properties: ['openFile'], filters: [{ name: __('VoxStorm teması'), extensions: ['voxtheme', 'json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const made = [];
    try {
      if (fs.statSync(r.filePaths[0]).size > FILE_MAX) throw new Error(__('Dosya çok büyük.'));
      let j;
      try { j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch (_) { j = null; }
      if (!j || typeof j !== 'object' || j.voxtheme !== 1 || !j.colors || typeof j.colors !== 'object') throw new Error(__('Bu bir VoxStorm tema dosyası değil.'));
      const keep = p => { if (p) made.push(p.file); return p; };
      const panels = {};
      for (const k of SLOTS) { const p = keep(unpackPic(j.panels && j.panels[k])); if (p) panels[k] = p; }
      return { theme: { name: String(j.name || __('Tema')).slice(0, 40), dark: typeof j.dark === 'boolean' ? j.dark : undefined, colors: j.colors, popup: j.popup, ansi: j.ansi, image: keep(unpackPic(j.image)), panels } };
    } catch (err) { made.forEach(removeImage); return { error: err.message }; }
  });

  return { importImage, removeImage };
};
