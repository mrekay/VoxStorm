// VoxStorm — updates from GitHub Releases (mrekay/claudelot)
//
// A release made by .github/workflows/release.yml carries:
//   VoxStorm-Setup-x.y.z.exe, VoxStorm-Portable-x.y.z.exe, voxstorm-app-x.y.z.asar
//   voxstorm-update.json  { version, electron, files: { setup|portable|asar: { name, size, sha256 } } }
// How an update is applied depends on how this copy runs:
//   nsis      installed with Setup  -> run the new Setup silently (/S), it reinstalls in place
//   portable  the single .exe       -> replace that .exe
//   asar      an unpacked folder    -> replace resources\app.asar (only when Electron is unchanged)
//   mac       VoxStorm.app          -> unzip VoxStorm-x.y.z-mac-<arch>.zip next to it and swap the bundle
//             (checked against the sha256 digest GitHub keeps for every release file)
//   appimage  Linux AppImage       -> replace the .AppImage file with VoxStorm-x.y.z-linux-x86_64.AppImage (same check)
//   linux     .deb install         -> announced only: the new .deb is installed with the package manager
// Every download is checked against the sha256 in voxstorm-update.json; a release without
// that file is only announced, never installed.
const path = require('path');
// original-fs: Electron's fs treats *.asar paths as archives, which breaks writing the update file
const fs = (() => { try { return require('original-fs'); } catch (_) { return require('fs'); } })();
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'mrekay/claudelot';
const API = process.env.CLAUDELOT_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

function newer(a, b) { // is version a newer than b? 0.7.0 > 0.7.0-beta.2 > 0.7.0-beta.1 > 0.6.0
  const p = v => { const [main, pre = ''] = String(v || '').replace(/^v/, '').split(/-(.*)/); return { n: main.split('.').map(n => parseInt(n, 10) || 0), pre }; };
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) > (y.n[i] || 0);
  if (x.pre === y.pre) return false;
  if (!x.pre || !y.pre) return !x.pre; // a release is newer than its pre-releases
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

module.exports = function updater({ app, net, DATA, settings, notify, onState, beforeRestart }) {
  const DIR = path.join(DATA, 'updates');
  const exe = process.execPath;
  // macOS: .../VoxStorm.app/Contents/MacOS/VoxStorm -> .../VoxStorm.app
  const bundle = process.platform === 'darwin' ? path.resolve(exe, '..', '..', '..') : '';
  // Linux: an AppImage (APPIMAGE = the file that was started) replaces itself; a .deb install
  // is updated by downloading the new .deb (dpkg needs root, so it is not done here)
  const kind = !app.isPackaged ? 'dev'
    : process.platform === 'linux' ? (process.env.APPIMAGE ? 'appimage' : 'linux')
    : process.platform !== 'win32' ? 'mac'
    : process.env.PORTABLE_EXECUTABLE_FILE ? 'portable'
    : ['Uninstall VoxStorm.exe', 'Uninstall Claudelot.exe'].some(n => fs.existsSync(path.join(path.dirname(exe), n))) ? 'nsis'
    : 'asar';
  // status: idle | checking | none | available | downloading | ready | manual | error
  const st = { status: 'idle', current: app.getVersion(), kind, latest: '', notes: '', url: '', publishedAt: '', progress: 0, error: '', reason: '', checkedAt: 0 };
  let release = null, manifest = null, file = null, downloading = null, applying = false;
  const told = new Set(); // notify once per version and state
  const tell = (key, title, body) => { if (told.has(key)) return; told.add(key); notify(title, body); };
  const emit = () => onState({ ...st });
  const set = patch => { Object.assign(st, patch); emit(); };

  async function getJson(url) {
    const r = await net.fetch(url, { headers: { 'User-Agent': 'VoxStorm', Accept: 'application/vnd.github+json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.status === 403 ? 'GitHub istek sınırına ulaşıldı, biraz sonra tekrar dene.' : `GitHub yanıtı: ${r.status}`);
    return r.json();
  }
  const asset = name => release && release.assets.find(a => a.name === name);
  // which file this copy needs, or why it cannot update itself
  function pick() {
    if (kind === 'dev') return { reason: 'Geliştirme modunda (npm start) güncelleme yapılmaz.' };
    if (kind === 'mac') return pickMac();
    if (kind === 'linux') return { reason: 'Paketle (.deb) kurulmuş: yeni sürümün .deb dosyasını sürüm sayfasından indirip kur.' };
    if (kind === 'appimage') return pickAppImage();
    if (!manifest) return { reason: 'Bu sürümde otomatik kurulum bilgisi yok; sürüm sayfasından indirebilirsin.' };
    const want = kind === 'nsis' ? 'setup' : kind === 'portable' ? 'portable' : 'asar';
    if (want === 'asar' && manifest.electron && manifest.electron !== process.versions.electron)
      return { reason: `Bu sürüm Electron'u da güncelliyor (${process.versions.electron} → ${manifest.electron}); klasör kurulumunda kurulum dosyasıyla güncellemek gerekiyor.` };
    const f = manifest.files && manifest.files[want];
    const a = f && asset(f.name);
    if (!f || !a || !/^[0-9a-f]{64}$/i.test(f.sha256 || '')) return { reason: 'Bu sürümde bu kurulum türü için dosya yok.' };
    return { want, f, a };
  }

  function pickMac() {
    if (!/\.app$/.test(bundle)) return { reason: 'Uygulama paketi bulunamadı; sürüm sayfasından indirebilirsin.' };
    // opened straight from the .dmg or from Downloads (macOS runs it from a read-only copy)
    if (/^\/Volumes\//.test(bundle) || bundle.includes('/AppTranslocation/'))
      return { reason: 'Otomatik güncelleme için VoxStorm\'u Uygulamalar klasörüne taşıyıp oradan aç.' };
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); }
    catch (_) { return { reason: `${path.dirname(bundle)} klasörüne yazılamıyor; sürüm sayfasından indirebilirsin.` }; }
    const name = `VoxStorm-${release.tag_name.replace(/^v/, '')}-mac-${process.arch}.zip`;
    const a = asset(name);
    const sha = a && /^sha256:([0-9a-f]{64})$/i.exec(a.digest || '');
    if (!a) return { reason: 'Bu sürümün macOS dosyası henüz yüklenmedi; biraz sonra tekrar kontrol et.' };
    if (!sha) return { reason: 'Bu sürümün macOS dosyası doğrulanamıyor; sürüm sayfasından indirebilirsin.' };
    return { want: 'mac', f: { name, size: a.size, sha256: sha[1].toLowerCase() }, a };
  }

  function pickAppImage() {
    const img = process.env.APPIMAGE;
    try { fs.accessSync(path.dirname(img), fs.constants.W_OK); fs.accessSync(img, fs.constants.W_OK); }
    catch (_) { return { reason: `${path.dirname(img)} klasörüne yazılamıyor; sürüm sayfasından indirebilirsin.` }; }
    // electron-builder names AppImages by the Linux arch name: x86_64 / arm64
    const name = `VoxStorm-${release.tag_name.replace(/^v/, '')}-linux-${process.arch === 'x64' ? 'x86_64' : process.arch}.AppImage`;
    const a = asset(name);
    const sha = a && /^sha256:([0-9a-f]{64})$/i.exec(a.digest || '');
    if (!a) return { reason: 'Bu sürümün Linux dosyası henüz yüklenmedi; biraz sonra tekrar kontrol et.' };
    if (!sha) return { reason: 'Bu sürümün Linux dosyası doğrulanamıyor; sürüm sayfasından indirebilirsin.' };
    return { want: 'appimage', f: { name, size: a.size, sha256: sha[1].toLowerCase() }, a };
  }

  async function check({ quiet } = {}) {
    if (st.status === 'downloading' || applying) return { ...st };
    set({ status: 'checking', error: '' });
    try {
      const rel = await getJson(API);
      st.checkedAt = Date.now();
      if (!rel || !rel.tag_name || rel.draft || rel.prerelease || !newer(rel.tag_name, st.current)) {
        release = null; manifest = null;
        set({ status: 'none', latest: rel && rel.tag_name ? rel.tag_name.replace(/^v/, '') : st.current });
        return { ...st };
      }
      release = rel;
      const m = rel.assets.find(a => a.name === 'voxstorm-update.json');
      manifest = m ? await getJson(m.browser_download_url).catch(() => null) : null;
      if (manifest && manifest.version && newer(rel.tag_name, manifest.version)) manifest = null; // stale manifest
      const p = pick();
      set({ status: p.reason ? 'manual' : 'available', latest: rel.tag_name.replace(/^v/, ''), notes: String(rel.body || '').slice(0, 4000),
        url: rel.html_url, publishedAt: rel.published_at || '', reason: p.reason || '' });
      // already downloaded earlier?
      if (!p.reason) {
        const target = path.join(DIR, p.f.name);
        if (fs.existsSync(target) && (await sha256(target)) === p.f.sha256.toLowerCase()) { file = { path: target, want: p.want }; set({ status: 'ready', progress: 1 }); }
        else if (settings().auto) download();
      }
      if (!quiet && (st.status === 'available' || st.status === 'manual')) tell(st.latest + ':found', `VoxStorm ${st.latest} çıktı`, st.status === 'manual' ? 'Ayrıntılar Ayarlar → Hakkında bölümünde.' : 'İndiriliyor; hazır olunca yeniden başlatman yeterli.');
    } catch (e) {
      set({ status: 'error', error: e.message });
    }
    return { ...st };
  }

  function sha256(p) {
    return new Promise((res, rej) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
    });
  }

  function download() {
    if (downloading) return downloading;
    const p = pick();
    if (p.reason) return Promise.resolve({ ...st });
    downloading = (async () => {
      set({ status: 'downloading', progress: 0, error: '' });
      await fsp.mkdir(DIR, { recursive: true });
      // keep only what this release needs
      for (const n of await fsp.readdir(DIR)) if (n !== p.f.name && !/\.(ps1|vbs|sh|log)$/.test(n)) await fsp.rm(path.join(DIR, n), { force: true, recursive: true }).catch(() => {});
      const tmp = path.join(DIR, p.f.name + '.part');
      try {
        const r = await net.fetch(p.a.browser_download_url, { headers: { 'User-Agent': 'VoxStorm', Accept: 'application/octet-stream' } });
        if (!r.ok || !r.body) throw new Error(`İndirme başarısız: ${r.status}`);
        const total = Number(r.headers.get('content-length')) || p.f.size || p.a.size || 0;
        const out = fs.createWriteStream(tmp);
        const h = crypto.createHash('sha256');
        let got = 0, last = 0;
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          h.update(buf); got += buf.length;
          if (!out.write(buf)) await new Promise(ok => out.once('drain', ok));
          if (total && Date.now() - last > 250) { last = Date.now(); set({ progress: Math.min(0.99, got / total) }); }
        }
        await new Promise((ok, bad) => out.end(err => (err ? bad(err) : ok())));
        if (h.digest('hex') !== p.f.sha256.toLowerCase()) throw new Error('İndirilen dosya doğrulanamadı (sha256 tutmuyor); kurulmadı.');
        const target = path.join(DIR, p.f.name);
        await fsp.rm(target, { force: true });
        await fsp.rename(tmp, target);
        file = { path: target, want: p.want };
        set({ status: 'ready', progress: 1 });
        tell(st.latest + ':ready', `VoxStorm ${st.latest} hazır`, 'Yeniden başlatınca kurulur. Çıkışta da kendiliğinden kurulur.');
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        set({ status: 'error', error: e.message });
      } finally { downloading = null; }
      return { ...st };
    })();
    return downloading;
  }

  /* Hand over to a small PowerShell script that waits for every VoxStorm process of this
     copy to exit, swaps the files, and (optionally) starts the new version. */
  function apply(relaunch) {
    if (!file || applying || st.status !== 'ready') return false;
    if (kind === 'mac') return applyMac(relaunch);
    if (kind === 'appimage') return applyAppImage(relaunch);
    applying = true;
    const ps1 = path.join(DIR, 'apply.ps1');
    const res = path.join(path.dirname(exe), 'resources');
    const waitFor = [exe, process.env.PORTABLE_EXECUTABLE_FILE].filter(Boolean);
    const q = s => "'" + String(s).replace(/'/g, "''") + "'";
    const step = {
      nsis: `Start-Process -FilePath ${q(file.path)} -ArgumentList '/S' -Wait`,
      portable: `Copy-Item -LiteralPath ${q(file.path)} -Destination ${q(process.env.PORTABLE_EXECUTABLE_FILE)} -Force`,
      asar: `$a = Join-Path ${q(res)} 'app.asar'; $old = Join-Path ${q(res)} 'app.asar.old'
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
  Move-Item -LiteralPath $a -Destination $old -Force
  try { Copy-Item -LiteralPath ${q(file.path)} -Destination $a -Force } catch { Move-Item -LiteralPath $old -Destination $a -Force; throw }`,
    }[kind];
    const start = kind === 'portable' ? process.env.PORTABLE_EXECUTABLE_FILE : exe;
    const args = process.argv.slice(1); // start the new version the way this one was started
    const script = `$ErrorActionPreference = 'Stop'
$log = ${q(path.join(DIR, 'apply.log'))}
function Log($m) { Add-Content -LiteralPath $log -Value ("{0:u} {1}" -f (Get-Date), $m) -Encoding UTF8 }
try {
  Log 'VoxStorm ${st.current} -> ${st.latest} (${kind})'
  $paths = @(${waitFor.map(q).join(', ')})
  for ($i = 0; $i -lt 120; $i++) {
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($paths -contains $_.Path) })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($left.Count -gt 0) { throw 'VoxStorm kapanmadı' }
  for ($try = 0; ; $try++) {
    try {
  ${step}
      break
    } catch { if ($try -ge 10) { throw } ; Start-Sleep -Milliseconds 700 }
  }
  Log 'kuruldu'
  ${kind !== 'nsis' ? `Remove-Item -LiteralPath ${q(file.path)} -Force -ErrorAction SilentlyContinue` : ''}
} catch { Log ("hata: " + $_) }
${relaunch ? `Start-Process -FilePath ${q(start)}${args.length ? ` -ArgumentList @(${args.map(a => q(/\s/.test(a) ? `"${a}"` : a)).join(', ')})` : ''}` : ''}
`;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ps1, '﻿' + script, 'utf8');
    // Start PowerShell through wscript: a plain detached spawn gives PowerShell no console and it
    // exits without running, and a non-detached child is killed with us (libuv job object).
    // wscript is a GUI program, so it detaches cleanly and gives PowerShell a hidden console.
    const vbs = path.join(DIR, 'apply.vbs');
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}"`;
    fs.writeFileSync(vbs, '﻿' + `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`, 'utf16le');
    spawn('wscript.exe', ['//B', '//Nologo', vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  }

  /* macOS: a detached shell script waits for this process to exit, unpacks the new VoxStorm.app
     next to the old one (same folder, so the move is atomic), swaps them and starts it again. */
  function applyMac(relaunch) {
    applying = true;
    const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const sh = path.join(DIR, 'apply.sh');
    const stage = path.join(path.dirname(bundle), '.VoxStorm-update');
    const script = `#!/bin/bash
LOG=${q(path.join(DIR, 'apply.log'))}
APP=${q(bundle)}
STAGE=${q(stage)}
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
log 'VoxStorm ${st.current} -> ${st.latest} (mac)'
for i in $(seq 1 120); do kill -0 ${process.pid} 2>/dev/null || break; sleep 0.5; done
if kill -0 ${process.pid} 2>/dev/null; then log 'hata: VoxStorm kapanmadı'; exit 1; fi
rm -rf "$STAGE" && mkdir -p "$STAGE"
if ! /usr/bin/ditto -x -k ${q(file.path)} "$STAGE"; then log 'hata: zip açılamadı'; rm -rf "$STAGE"; exit 1; fi
NEW=$(find "$STAGE" -maxdepth 1 -name '*.app' | head -n 1)
if [ -z "$NEW" ]; then log 'hata: zip içinde .app yok'; rm -rf "$STAGE"; exit 1; fi
/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null
rm -rf "$APP.old"
if mv "$APP" "$APP.old" && mv "$NEW" "$APP"; then
  log 'kuruldu'; rm -rf "$APP.old" ${q(file.path)}
else
  log 'hata: değiştirilemedi, eski sürüm geri kondu'; [ -d "$APP.old" ] && [ ! -d "$APP" ] && mv "$APP.old" "$APP"
fi
rm -rf "$STAGE"
${relaunch ? `/usr/bin/open -n "$APP"${process.argv.length > 1 ? ' --args ' + process.argv.slice(1).map(q).join(' ') : ''}` : ''}
`;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(sh, script, { mode: 0o755 });
    spawn('/bin/bash', [sh], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  /* Linux AppImage: a detached script waits for this process to exit, puts the new AppImage in
     place of the old one (same folder, so the rename is atomic) and starts it again. */
  function applyAppImage(relaunch) {
    applying = true;
    const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const img = process.env.APPIMAGE;
    const sh = path.join(DIR, 'apply.sh');
    const script = `#!/bin/sh
LOG=${q(path.join(DIR, 'apply.log'))}
IMG=${q(img)}
NEW=${q(file.path)}
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
log 'VoxStorm ${st.current} -> ${st.latest} (appimage)'
i=0; while kill -0 ${process.pid} 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done
if kill -0 ${process.pid} 2>/dev/null; then log 'hata: VoxStorm kapanmadı'; exit 1; fi
TMP="$IMG.new"
if cp "$NEW" "$TMP" && chmod +x "$TMP" && mv -f "$TMP" "$IMG"; then log 'kuruldu'; rm -f "$NEW"; else log 'hata: değiştirilemedi'; rm -f "$TMP"; fi
${relaunch ? `nohup "$IMG"${process.argv.length > 1 ? ' ' + process.argv.slice(1).map(q).join(' ') : ''} >/dev/null 2>&1 &` : ''}
`;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(sh, script, { mode: 0o755 });
    spawn('/bin/sh', [sh], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  function restart() {
    if (!apply(true)) return false;
    beforeRestart();
    return true;
  }
  // quitting with a downloaded update installs it on the way out
  function onQuit() { if (st.status === 'ready' && settings().auto) apply(false); }

  function start() {
    if (kind === 'dev') { set({ status: 'idle', reason: 'Geliştirme modunda (npm start) güncelleme yapılmaz.' }); return; }
    // the previous app.asar kept by an update for rollback; no longer needed once we are running
    if (kind === 'asar') fsp.rm(path.join(path.dirname(exe), 'resources', 'app.asar.old'), { force: true }).catch(() => {});
    const tick = () => { if (settings().check) check({ quiet: false }).catch(() => {}); };
    setTimeout(tick, 20000);
    setInterval(tick, CHECK_EVERY);
  }

  return { state: () => ({ ...st }), check, download, restart, onQuit, start };
};
module.exports.newer = newer;
