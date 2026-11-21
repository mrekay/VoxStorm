// VoxStorm — background images of custom themes. A chosen picture is copied into <userData>/themes so the
// theme keeps working when the original moves; the window shows it through a file:// URL (img-src allows it).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'];
const MAX = 25 * 1024 * 1024;

module.exports = function registerThemes({ ipcMain, dialog, BrowserWindow, DATA }) {
  const DIR = path.join(DATA, 'themes');

  function importImage(src) {
    src = String(src || '');
    if (!path.isAbsolute(src)) throw new Error('Resim yolu tam yol olmalı.');
    const ext = path.extname(src).toLowerCase();
    if (!EXT.includes(ext)) throw new Error('Desteklenen resim türleri: ' + EXT.join(', '));
    const st = fs.statSync(src);
    if (!st.isFile()) throw new Error('Resim bulunamadı: ' + src);
    if (st.size > MAX) throw new Error('Resim 25 MB’tan büyük olamaz.');
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
    const r = await dialog.showOpenDialog(w, { title: 'Arka plan resmi seç', properties: ['openFile'], filters: [{ name: 'Resimler', extensions: EXT.map(x => x.slice(1)) }] });
    if (r.canceled || !r.filePaths[0]) return null;
    try { return importImage(r.filePaths[0]); } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('theme:removeImage', (_e, file) => removeImage(file));

  return { importImage, removeImage };
};
