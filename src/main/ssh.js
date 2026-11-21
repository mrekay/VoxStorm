// VoxStorm — SSH mode (PuTTY + WinSCP in one), main-process side.
// Saved hosts (passwords / key passphrases encrypted with Electron safeStorage, never sent back to
// the window), host key check against our own known-hosts file, interactive shells, SFTP browsing
// and file operations, a transfer queue (each job has its own SFTP channel so it can be cancelled),
// local port forwarding (tunnels) and launching Remote Desktop (mstsc) for RDP hosts.
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { execFile, spawn } = require('child_process');
const { safeStorage, shell } = require('electron');
const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';

const COLORS = new Set(['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']);
const MAX_EDIT = 5 * 1024 * 1024; // bytes of a remote file opened in the editor

let ssh2Lib = null;
const ssh2 = () => ssh2Lib || (ssh2Lib = require('ssh2'));

module.exports = function registerSsh({ ipcMain, dialog, getWin, send, sendTo, DATA }) {
  // events go to the window that opened the session (SSH mode may live in a window of its own)
  const out = (wc, ch, ...a) => { if (sendTo) sendTo(wc, ch, ...a); else if (send) send(ch, ...a); };
  const FILES = {
    hosts: path.join(DATA, 'ssh-hosts.json'),
    known: path.join(DATA, 'ssh-known-hosts.json'),
    state: path.join(DATA, 'ssh-state.json'),
  };
  const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; } };
  const data = {
    hosts: readJson(FILES.hosts, { hosts: [] }),
    known: readJson(FILES.known, {}),
    state: readJson(FILES.state, null),
  };
  if (!Array.isArray(data.hosts.hosts)) data.hosts.hosts = [];
  if (!data.known || typeof data.known !== 'object') data.known = {};
  const timers = {};
  function writeNow(k) {
    clearTimeout(timers[k]); timers[k] = null;
    try { const tmp = FILES[k] + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data[k], null, 1), 'utf8'); fs.renameSync(tmp, FILES[k]); } catch (_) {}
  }
  const write = (k, now) => { if (now) writeNow(k); else if (!timers[k]) timers[k] = setTimeout(() => writeNow(k), 500); };
  const hosts = () => data.hosts.hosts;
  const hostById = id => hosts().find(h => h.id === id);
  const newId = () => crypto.randomUUID().slice(0, 12);

  /* ---------------- secrets ---------------- */
  const mem = new Map(); // `${id}:pw` / `${id}:pp` -> secret given this run
  const canEncrypt = () => require('./platform').canEncrypt(safeStorage); // false on Linux without a keyring
  const encrypt = s => safeStorage.encryptString(String(s)).toString('base64');
  const decrypt = b => { try { return safeStorage.decryptString(Buffer.from(b, 'base64')); } catch (_) { return null; } };
  function secretOf(h, kind) { // kind: 'pw' | 'pp'
    const k = `${h.id}:${kind}`;
    if (mem.has(k)) return mem.get(k);
    const stored = kind === 'pw' ? h.pwd : h.pph;
    if (h.askPassword) return null;
    if (stored) return decrypt(stored);
    return null;
  }
  const publicHost = h => {
    const { pwd, pph, ...rest } = h;
    return { ...rest, hasPassword: !!pwd || mem.has(h.id + ':pw'), hasPassphrase: !!pph || mem.has(h.id + ':pp') };
  };
  const scrub = (msg, ...secrets) => { msg = String(msg || ''); for (const s of secrets) if (s && s.length > 2) msg = msg.split(s).join('•••'); return msg; };

  function cleanTunnels(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 20).map(t => {
      const lp = parseInt(t.localPort, 10), rp = parseInt(t.remotePort, 10);
      if (!(lp > 0 && lp < 65536 && rp > 0 && rp < 65536)) return null;
      return { localPort: lp, remoteHost: String(t.remoteHost || '127.0.0.1').trim().slice(0, 255) || '127.0.0.1', remotePort: rp, auto: !!t.auto };
    }).filter(Boolean);
  }
  function clean(d) {
    const s = v => (typeof v === 'string' ? v.trim() : '');
    const kind = d.kind === 'rdp' ? 'rdp' : 'ssh';
    const port = parseInt(d.port, 10);
    return {
      kind,
      name: s(d.name).slice(0, 80),
      host: s(d.host).slice(0, 255),
      port: port > 0 && port < 65536 ? port : (kind === 'rdp' ? 3389 : 22),
      user: s(d.user).slice(0, 128),
      auth: ['password', 'key', 'agent'].includes(d.auth) ? d.auth : 'password',
      keyPath: s(d.keyPath).slice(0, 1024),
      askPassword: !!d.askPassword,
      color: COLORS.has(d.color) ? d.color : '',
      group: s(d.group).slice(0, 60),
      startDir: s(d.startDir).slice(0, 1024),
      localDir: s(d.localDir).slice(0, 1024),
      keepalive: Math.max(0, Math.min(600, parseInt(d.keepalive, 10) || 30)),
      tunnels: cleanTunnels(d.tunnels),
      // Claude / Codex through VoxStorm (agentlink.js): '' = ask, 'allow', 'deny'
      aiAccess: ['allow', 'deny'].includes(d.aiAccess) ? d.aiAccess : '',
      // RDP
      fullscreen: !!d.fullscreen,
      admin: !!d.admin,
      domain: s(d.domain).slice(0, 128),
    };
  }
  const label = h => h.name || `${h.user ? h.user + '@' : ''}${h.host}${h.port && h.port !== 22 ? ':' + h.port : ''}`;

  ipcMain.handle('ssh:list', () => ({ hosts: hosts().map(publicHost), canEncrypt: canEncrypt(), home: os.homedir() }));
  ipcMain.handle('ssh:save', (_e, d) => {
    const v = clean(d || {});
    if (!v.host) throw new Error('Sunucu adresi boş olamaz.');
    let h = d.id && hostById(d.id);
    if (h) { Object.assign(h, v); dropAgent(h.id); } else { h = { id: newId(), ...v }; hosts().push(h); }
    if (typeof d.pw === 'string' && d.pw) {
      mem.set(h.id + ':pw', d.pw);
      if (!h.askPassword && canEncrypt()) h.pwd = encrypt(d.pw);
    }
    if (typeof d.pp === 'string' && d.pp) {
      mem.set(h.id + ':pp', d.pp);
      if (!h.askPassword && canEncrypt()) h.pph = encrypt(d.pp);
    }
    if (d.clearPw || h.askPassword) { delete h.pwd; delete h.pph; if (d.clearPw) { mem.delete(h.id + ':pw'); mem.delete(h.id + ':pp'); } }
    if (h.auth !== 'password' && h.kind === 'ssh') delete h.pwd;
    if (h.auth !== 'key') delete h.pph;
    write('hosts', true);
    return publicHost(h);
  });
  ipcMain.handle('ssh:delete', (_e, id) => {
    const i = hosts().findIndex(h => h.id === id);
    if (i >= 0) { dropAgent(id); hosts().splice(i, 1); mem.delete(id + ':pw'); mem.delete(id + ':pp'); write('hosts', true); }
    return true;
  });
  ipcMain.handle('ssh:duplicate', (_e, id) => {
    const h = hostById(id); if (!h) return null;
    const c = { ...JSON.parse(JSON.stringify(h)), id: newId(), name: (h.name || label(h)) + ' (kopya)' };
    hosts().splice(hosts().indexOf(h) + 1, 0, c);
    write('hosts', true);
    return publicHost(c);
  });
  ipcMain.handle('ssh:reorder', (_e, ids) => {
    if (!Array.isArray(ids)) return false;
    const map = new Map(hosts().map(h => [h.id, h]));
    const out = ids.map(id => map.get(id)).filter(Boolean);
    hosts().forEach(h => { if (!out.includes(h)) out.push(h); });
    data.hosts.hosts = out; write('hosts', true);
    return true;
  });
  ipcMain.handle('ssh:getState', () => ({ state: data.state }));
  ipcMain.handle('ssh:setState', (_e, st) => { data.state = st && typeof st === 'object' ? st : null; write('state'); return true; });
  ipcMain.handle('ssh:pickKey', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: 'Özel anahtar dosyası seç', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'],
      filters: [{ name: 'Anahtar dosyaları', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  /* ---------------- connections ---------------- */
  // sid -> { id, hostId, client, shells: Map, sftp, sftpWait, tunnels: [], closed }
  const sessions = new Map();
  const shells = new Map(); // chId -> { sid, wc, write, resize, close }
  let seq = 0;
  const knownKey = h => `${h.host.toLowerCase()}:${h.port || 22}`;

  function readKey(h) {
    if (!h.keyPath) throw new Error('Özel anahtar dosyası seçilmedi.');
    let p = h.keyPath.replace(/^~(?=[\\/]|$)/, os.homedir());
    try { return fs.readFileSync(p); } catch (e) { throw new Error('Anahtar dosyası okunamadı: ' + p); }
  }
  function isPpk(buf) { return /^PuTTY-User-Key-File-/.test(buf.slice(0, 40).toString('latin1')); }
  function keyNeedsPassphrase(buf) {
    const t = buf.toString('latin1');
    if (/ENCRYPTED/.test(t.slice(0, 400))) return true;
    if (isPpk(buf)) return /Encryption:\s*(?!none)/.test(t);
    if (/BEGIN OPENSSH PRIVATE KEY/.test(t)) {
      try { const b64 = t.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''); const raw = Buffer.from(b64, 'base64'); return !raw.slice(15, 40).toString('latin1').includes('none'); } catch (_) { return false; }
    }
    return false;
  }

  /* opts: { password, passphrase, acceptKey, remember } */
  function connectClient(h, opts, onClose) {
    return new Promise(resolve => {
      const { Client } = ssh2();
      const c = new Client();
      let pw = typeof opts.password === 'string' ? opts.password : (h.auth === 'password' ? secretOf(h, 'pw') : null);
      let pp = typeof opts.passphrase === 'string' ? opts.passphrase : (h.auth === 'key' ? secretOf(h, 'pp') : null);
      const cfg = {
        host: h.host, port: h.port || 22, username: h.user || os.userInfo().username,
        readyTimeout: 20000, keepaliveInterval: (h.keepalive || 0) * 1000, keepaliveCountMax: 4,
        tryKeyboard: true,
      };
      if (h.auth === 'password') {
        if (pw == null) { resolve({ needPassword: true, what: 'pw' }); return; }
        cfg.password = pw;
      } else if (h.auth === 'key') {
        let buf;
        try { buf = readKey(h); } catch (e) { resolve({ error: e.message }); return; }
        if (keyNeedsPassphrase(buf) && pp == null) { resolve({ needPassword: true, what: 'pp' }); return; }
        cfg.privateKey = buf;
        if (pp) cfg.passphrase = pp;
      } else {
        // Windows: the OpenSSH agent service when it runs, otherwise Pageant
        const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
        if (process.platform !== 'win32') cfg.agent = process.env.SSH_AUTH_SOCK;
        else cfg.agent = fs.existsSync(pipe) ? pipe : 'pageant';
      }
      let hostIssue = null, done = false;
      const finish = r => { if (done) return; done = true; resolve(r); };
      cfg.hostVerifier = key => {
        const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        const k = knownKey(h), known = data.known[k];
        if (known && known.fp === fp) return true;
        if (opts.acceptKey && opts.acceptKey === fp) {
          data.known[k] = { fp, at: new Date().toISOString() }; write('known', true);
          return true;
        }
        hostIssue = { hostKey: fp, changed: !!known, oldKey: known ? known.fp : '' };
        return false;
      };
      c.on('keyboard-interactive', (_name, _instr, _lang, prompts, reply) => {
        reply(prompts.map(() => (pw != null ? pw : '')));
      });
      c.on('ready', () => {
        if (h.auth === 'password' && pw != null) mem.set(h.id + ':pw', pw);
        if (h.auth === 'key' && pp) mem.set(h.id + ':pp', pp);
        if (opts.remember && !h.askPassword && canEncrypt()) {
          if (h.auth === 'password' && pw) h.pwd = encrypt(pw);
          if (h.auth === 'key' && pp) h.pph = encrypt(pp);
          write('hosts', true);
        }
        finish({ client: c });
      });
      c.on('error', err => {
        if (hostIssue) { finish(hostIssue); return; }
        const msg = scrub(err && err.message, pw, pp);
        if (err && err.level === 'client-authentication') {
          if (h.auth === 'password') { mem.delete(h.id + ':pw'); finish({ needPassword: true, what: 'pw', loginFailed: true, error: 'Kullanıcı adı ya da parola hatalı.' }); return; }
          if (h.auth === 'key') { finish({ error: 'Sunucu anahtarı kabul etmedi (' + msg + ').' }); return; }
          finish({ error: 'Ajan (ssh-agent / Pageant) üzerinden giriş yapılamadı.' }); return;
        }
        if (/passphrase|decrypt|Encrypted private/i.test(msg)) { mem.delete(h.id + ':pp'); finish({ needPassword: true, what: 'pp', loginFailed: true, error: 'Anahtar parolası hatalı.' }); return; }
        if (/Cannot parse privateKey|Unsupported key format/i.test(msg)) { finish({ error: 'Anahtar dosyası okunamadı: ' + msg }); return; }
        finish({ error: friendlyNetErr(msg) });
      });
      c.on('close', () => { if (!done) finish(hostIssue || { error: 'Bağlantı kapandı.' }); else if (onClose) onClose(); });
      try { c.connect(cfg); } catch (e) { finish({ error: scrub(e.message, pw, pp) }); }
    });
  }
  function friendlyNetErr(msg) {
    if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'Sunucu adı çözümlenemedi (' + msg + ').';
    if (/ECONNREFUSED/.test(msg)) return 'Bağlantı reddedildi: sunucuda SSH servisi bu portta çalışmıyor olabilir.';
    if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(msg)) return 'Zaman aşımı: sunucuya ulaşılamadı.';
    if (/ECONNRESET/.test(msg)) return 'Bağlantı sunucu tarafından kesildi.';
    return msg;
  }

  ipcMain.handle('ssh:connect', async (e, hostId, opts = {}) => {
    const h = hostById(hostId);
    if (!h) return { error: 'Bağlantı bulunamadı.' };
    if (h.kind !== 'ssh') return { error: 'Bu bir RDP bağlantısı.' };
    const sid = 's' + (++seq) + crypto.randomBytes(3).toString('hex');
    const r = await connectClient(h, opts, () => closeSession(sid, 'Bağlantı kapandı.'));
    if (!r.client) return r;
    const s = { id: sid, hostId, client: r.client, sftp: null, sftpWait: null, tunnels: [], closed: false, wc: e && e.sender };
    sessions.set(sid, s);
    if (s.wc && s.wc.once) s.wc.once('destroyed', () => closeSession(sid, ''));
    r.client.on('error', () => {});
    const tunnelErrors = [];
    for (const t of h.tunnels || []) if (t.auto) { const e = await openTunnel(s, t); if (e) tunnelErrors.push(e); }
    let home = '';
    try { home = await sftpOf(s).then(sf => realpath(sf, '.')); } catch (_) {}
    return { sid, banner: '', home, tunnels: tunnelList(s), tunnelErrors, label: label(h) };
  });
  function closeSession(sid, reason) {
    const s = sessions.get(sid); if (!s || s.closed) return;
    s.closed = true;
    sessions.delete(sid);
    for (const [ch, x] of shells) if (x.sid === sid) { shells.delete(ch); out(x.wc, 'ssh:exit', ch, reason || ''); }
    for (const t of s.tunnels) { try { t.server.close(); } catch (_) {} }
    for (const j of jobs.values()) if (j.sid === sid && !j.finished) cancelJob(j, 'Bağlantı kapandı.');
    try { s.client.end(); } catch (_) {}
    out(s.wc, 'ssh:closed', sid, reason || '');
  }
  ipcMain.handle('ssh:disconnect', (_e, sid) => { closeSession(sid, ''); return true; });

  /* ---------------- shells ----------------
     A channel is anything the window types into and reads from: an SSH shell, a command run on
     the server with a pty (docker exec), or a local pty handed in by docker.js (addChannel). */
  function addChannel(wc, sid, impl) {
    const ch = 'c' + (++seq);
    shells.set(ch, { sid, wc, ...impl });
    return {
      ch,
      data: d => out(wc, 'ssh:data', ch, d),
      exit: why => { if (shells.delete(ch)) out(wc, 'ssh:exit', ch, why || ''); },
    };
  }
  function streamChannel(s, stream) {
    const c = addChannel(s.wc, s.id, {
      write: d => stream.write(d),
      resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
      close: () => stream.end(),
    });
    const dec = new StringDecoder('utf8'), dec2 = new StringDecoder('utf8');
    stream.on('data', d => c.data(dec.write(d)));
    if (stream.stderr) stream.stderr.on('data', d => c.data(dec2.write(d)));
    stream.on('close', () => c.exit(''));
    return c.ch;
  }
  ipcMain.handle('ssh:shell', (_e, sid, cols, rows) => new Promise(resolve => {
    const s = sessions.get(sid); if (!s) { resolve({ error: 'Bağlantı yok.' }); return; }
    s.client.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, { env: { LANG: 'en_US.UTF-8' } }, (err, stream) => {
      if (err) { resolve({ error: err.message }); return; }
      resolve({ ch: streamChannel(s, stream) });
    });
  }));
  // run a command on the server with a terminal (e.g. docker exec -it); its output is a channel
  function execPty(sid, cmd, cols, rows) {
    return new Promise(resolve => {
      const s = sessions.get(sid); if (!s) { resolve({ error: 'Bağlantı kapalı.' }); return; }
      s.client.exec(cmd, { pty: { term: 'xterm-256color', cols: cols || 80, rows: rows || 24 } }, (err, stream) => {
        if (err) { resolve({ error: err.message }); return; }
        resolve({ ch: streamChannel(s, stream) });
      });
    });
  }
  // run a command on the server and collect its output (no terminal)
  function execOut(sid, cmd, { timeout = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
    return new Promise(resolve => {
      const s = sessions.get(sid); if (!s) { resolve({ code: -1, stdout: '', stderr: 'Bağlantı kapalı.' }); return; }
      s.client.exec(cmd, (err, stream) => {
        if (err) { resolve({ code: -1, stdout: '', stderr: err.message }); return; }
        const out1 = [], out2 = []; let n = 0, done = false;
        const fin = code => { if (done) return; done = true; clearTimeout(t); resolve({ code, stdout: Buffer.concat(out1).toString('utf8'), stderr: Buffer.concat(out2).toString('utf8') }); };
        const t = setTimeout(() => { try { stream.close(); } catch (_) {} fin(-2); }, timeout);
        stream.on('data', d => { n += d.length; if (n <= maxBytes) out1.push(d); });
        stream.stderr.on('data', d => out2.push(d));
        stream.on('exit', code => { stream.exitCode = code; });
        stream.on('close', () => fin(stream.exitCode == null ? 0 : stream.exitCode));
      });
    });
  }
  // a streaming command (docker logs -f): calls onData until stopped; returns stop()
  function execStream(sid, cmd, onData, onEnd) {
    const s = sessions.get(sid); if (!s) { onEnd('Bağlantı kapalı.'); return () => {}; }
    let stream = null, stopped = false;
    s.client.exec(cmd, (err, st) => {
      if (err) { onEnd(err.message); return; }
      stream = st;
      if (stopped) { try { st.close(); } catch (_) {} return; }
      const dec = new StringDecoder('utf8'), dec2 = new StringDecoder('utf8');
      st.on('data', d => onData(dec.write(d)));
      st.stderr.on('data', d => onData(dec2.write(d)));
      st.on('close', () => onEnd(''));
    });
    return () => { stopped = true; if (stream) { try { stream.close(); } catch (_) {} } };
  }
  ipcMain.on('ssh:write', (_e, ch, d) => { const x = shells.get(ch); if (x) { try { x.write(d); } catch (_) {} } });
  ipcMain.on('ssh:resize', (_e, ch, cols, rows) => { const x = shells.get(ch); if (x && cols > 0 && rows > 0) { try { x.resize(cols, rows); } catch (_) {} } });
  ipcMain.on('ssh:closeShell', (_e, ch) => { const x = shells.get(ch); if (x) { shells.delete(ch); try { x.close(); } catch (_) {} } });

  /* ---------------- SFTP ---------------- */
  function openSftp(s) {
    return new Promise((res, rej) => s.client.sftp((err, sf) => (err ? rej(err) : res(sf))));
  }
  function sftpOf(s) {
    if (s.sftp) return Promise.resolve(s.sftp);
    if (!s.sftpWait) {
      s.sftpWait = openSftp(s).then(sf => {
        s.sftp = sf; s.sftpWait = null;
        sf.on('close', () => { if (s.sftp === sf) s.sftp = null; });
        return sf;
      }, e => { s.sftpWait = null; throw new Error('SFTP açılamadı: ' + e.message); });
    }
    return s.sftpWait;
  }
  const P = fn => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));
  const realpath = (sf, p) => P(cb => sf.realpath(p, cb));
  const rjoin = (a, b) => (a.endsWith('/') ? a + b : a + '/' + b);
  const rparent = p => { if (p === '/' || !p) return '/'; const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  const sftpErr = (e, p) => {
    const code = e && e.code;
    if (code === 2) return 'Bulunamadı: ' + p;
    if (code === 3) return 'İzin yok: ' + p;
    if (code === 4) return 'İşlem başarısız: ' + p + ' (klasör boş olmayabilir ya da hedef zaten var)';
    return (e && e.message) || String(e);
  };
  function permString(mode, isDir, isLink) {
    const t = isLink ? 'l' : isDir ? 'd' : '-';
    const r = (m, s) => (m & 4 ? 'r' : '-') + (m & 2 ? 'w' : '-') + (m & 1 ? 'x' : '-');
    return t + r((mode >> 6) & 7) + r((mode >> 3) & 7) + r(mode & 7);
  }
  async function sess(sid) {
    const s = sessions.get(sid);
    if (!s) throw new Error('Bağlantı kapalı. Yeniden bağlan.');
    return { s, sf: await sftpOf(s) };
  }
  ipcMain.handle('ssh:ls', async (_e, sid, dir) => {
    try {
      const { sf } = await sess(sid);
      const p = await realpath(sf, dir || '.');
      const list = await P(cb => sf.readdir(p, cb));
      const items = await Promise.all(list.map(async f => {
        const a = f.attrs, isLink = a.isSymbolicLink();
        let isDir = a.isDirectory(), size = a.size, broken = false;
        if (isLink) {
          try { const st = await P(cb => sf.stat(rjoin(p, f.filename), cb)); isDir = st.isDirectory(); size = st.size; } catch (_) { broken = true; }
        }
        return { name: f.filename, dir: isDir, link: isLink, broken, size: isDir ? null : size, mtime: a.mtime * 1000, mode: a.mode & 0o7777, perm: permString(a.mode, isDir && !isLink ? true : isDir, isLink), uid: a.uid, gid: a.gid, owner: (f.longname || '').split(/\s+/)[2] || String(a.uid) };
      }));
      return { path: p, items };
    } catch (e) { return { error: sftpErr(e, dir) }; }
  });
  ipcMain.handle('ssh:op', async (_e, sid, op, a = {}) => {
    try {
      const { sf } = await sess(sid);
      if (op === 'mkdir') { await P(cb => sf.mkdir(a.path, cb)); return { ok: true }; }
      if (op === 'touch') {
        const exists = await P(cb => sf.stat(a.path, cb)).then(() => true, () => false);
        if (exists) return { error: 'Bu adda bir öğe zaten var.' };
        await P(cb => sf.writeFile(a.path, '', cb)); return { ok: true };
      }
      if (op === 'rename') { await P(cb => sf.rename(a.from, a.to, cb)); return { ok: true }; }
      if (op === 'chmod') { await P(cb => sf.chmod(a.path, a.mode, cb)); return { ok: true }; }
      if (op === 'delete') { for (const p of a.paths || []) await rmRemote(sf, p); return { ok: true }; }
      if (op === 'stat') { const st = await P(cb => sf.stat(a.path, cb)); return { dir: st.isDirectory(), size: st.size, mode: st.mode & 0o7777 }; }
      if (op === 'read') {
        const st = await P(cb => sf.stat(a.path, cb));
        if (st.isDirectory()) return { error: 'Bu bir klasör.' };
        if (st.size > MAX_EDIT) return { error: `Dosya düzenlemek için çok büyük (${Math.round(st.size / 1048576)} MB). İndirip aç.` };
        const buf = await P(cb => sf.readFile(a.path, cb));
        if (buf.includes(0)) return { error: 'İkili (binary) dosya; düzenleyicide açılamaz.', binary: true };
        return { text: buf.toString('utf8'), size: st.size, mtime: st.mtime * 1000, crlf: /\r\n/.test(buf.toString('latin1', 0, Math.min(buf.length, 65536))) };
      }
      if (op === 'write') {
        if (a.mtime) {
          const st = await P(cb => sf.stat(a.path, cb)).catch(() => null);
          if (st && st.mtime * 1000 !== a.mtime && !a.force) return { conflict: true };
        }
        const tmp = a.path + '.voxstorm-tmp';
        const mode = await P(cb => sf.stat(a.path, cb)).then(st => st.mode & 0o7777, () => null);
        await P(cb => sf.writeFile(tmp, Buffer.from(a.text, 'utf8'), cb));
        if (mode != null) await P(cb => sf.chmod(tmp, mode, cb)).catch(() => {});
        try { await P(cb => sf.ext_openssh_rename(tmp, a.path, cb)); }
        catch (_) { await P(cb => sf.unlink(a.path, cb)).catch(() => {}); await P(cb => sf.rename(tmp, a.path, cb)); }
        const st = await P(cb => sf.stat(a.path, cb));
        return { ok: true, mtime: st.mtime * 1000 };
      }
      if (op === 'du') { // size of a selection (folders recursively)
        let total = 0, files = 0, dirs = 0;
        const walk = async p => {
          const st = await P(cb => sf.lstat(p, cb));
          if (st.isDirectory()) { dirs++; for (const f of await P(cb => sf.readdir(p, cb))) await walk(rjoin(p, f.filename)); }
          else { files++; total += st.size; }
        };
        for (const p of a.paths || []) await walk(p);
        return { total, files, dirs };
      }
      return { error: 'Bilinmeyen işlem.' };
    } catch (e) { return { error: sftpErr(e, a.path || a.from || '') }; }
  });
  async function rmRemote(sf, p) {
    const st = await P(cb => sf.lstat(p, cb));
    if (st.isDirectory()) {
      for (const f of await P(cb => sf.readdir(p, cb))) await rmRemote(sf, rjoin(p, f.filename));
      await P(cb => sf.rmdir(p, cb));
    } else await P(cb => sf.unlink(p, cb));
  }

  /* ---------------- local side (left pane) ---------------- */
  function drives() {
    const out = [];
    for (let i = 67; i <= 90; i++) { const d = String.fromCharCode(i) + ':\\'; try { fs.accessSync(d); out.push({ name: d, dir: true, drive: true }); } catch (_) {} }
    return out;
  }
  ipcMain.handle('ssh:localLs', async (_e, dir) => {
    try {
      // Windows: '' is "this computer", the list of drives; elsewhere everything starts at /
      if (!dir) { if (IS_WIN) return { path: '', items: drives() }; dir = '/'; }
      const p = path.resolve(dir);
      const ents = await fs.promises.readdir(p, { withFileTypes: true });
      const items = [];
      for (const d of ents) {
        const fp = path.join(p, d.name);
        let st = null; try { st = await fs.promises.stat(fp); } catch (_) {}
        const isDir = st ? st.isDirectory() : d.isDirectory();
        items.push({ name: d.name, dir: isDir, link: d.isSymbolicLink(), size: isDir || !st ? null : st.size, mtime: st ? st.mtimeMs : 0, hidden: d.name.startsWith('.') });
      }
      return { path: p, items };
    } catch (e) { return { error: e.code === 'ENOENT' ? 'Klasör bulunamadı: ' + dir : e.code === 'EPERM' || e.code === 'EACCES' ? 'Erişim izni yok: ' + dir : e.message }; }
  });
  ipcMain.handle('ssh:localOp', async (_e, op, a = {}) => {
    try {
      if (op === 'mkdir') { await fs.promises.mkdir(a.path); return { ok: true }; }
      if (op === 'rename') { if (fs.existsSync(a.to)) return { error: 'Bu adda bir öğe zaten var.' }; await fs.promises.rename(a.from, a.to); return { ok: true }; }
      if (op === 'trash') { for (const p of a.paths || []) await shell.trashItem(p); return { ok: true }; }
      if (op === 'open') { const r = await shell.openPath(a.path); return r ? { error: r } : { ok: true }; }
      if (op === 'reveal') { shell.showItemInFolder(a.path); return { ok: true }; }
      if (op === 'pickDir') {
        const r = await dialog.showOpenDialog(getWin(), { title: 'Klasör seç', defaultPath: a.path || os.homedir(), properties: ['openDirectory', 'createDirectory'] });
        return r.canceled ? { canceled: true } : { path: r.filePaths[0] };
      }
      if (op === 'isDir') { try { return { dir: fs.statSync(a.path).isDirectory() }; } catch (_) { return { dir: false }; } }
      return { error: 'Bilinmeyen işlem.' };
    } catch (e) { return { error: e.message }; }
  });

  /* ---------------- transfers ----------------
     A job copies one or more top-level items (files or folders) in one direction on its own SFTP
     channel. Cancel ends that channel, which makes the running fastGet / fastPut fail at once. */
  const jobs = new Map();
  function emitJob(j) {
    out(j.wc, 'ssh:xfer', { id: j.id, sid: j.sid, dir: j.dir, name: j.name, target: j.target, total: j.total, done: j.done, files: j.files, filesDone: j.filesDone, current: j.current, state: j.state, error: j.error || '', speed: j.speed || 0, started: j.started, skipped: j.skipped || 0 });
  }
  function cancelJob(j, why) {
    if (j.finished) return;
    j.canceled = true; j.state = 'canceled'; j.error = why || '';
    try { if (j.sf) j.sf.end(); } catch (_) {}
    if (j.resolveAsk) j.resolveAsk('cancel');
  }
  ipcMain.handle('ssh:xferCancel', (_e, id) => { const j = jobs.get(id); if (j) { cancelJob(j, ''); emitJob(j); } return true; });
  ipcMain.handle('ssh:xferAnswer', (_e, id, answer) => { const j = jobs.get(id); if (j && j.resolveAsk) j.resolveAsk(answer); return true; });

  async function planUpload(paths, remoteDir) {
    const list = [];
    const walk = async (lp, rp) => {
      const st = await fs.promises.stat(lp);
      if (st.isDirectory()) {
        list.push({ dir: true, local: lp, remote: rp });
        for (const n of await fs.promises.readdir(lp)) await walk(path.join(lp, n), rjoin(rp, n));
      } else list.push({ local: lp, remote: rp, size: st.size, mtime: st.mtimeMs });
    };
    for (const p of paths) await walk(p, rjoin(remoteDir, path.basename(p)));
    return list;
  }
  async function planDownload(sf, paths, localDir) {
    const list = [];
    const walk = async (rp, lp) => {
      const st = await P(cb => sf.stat(rp, cb));
      if (st.isDirectory()) {
        list.push({ dir: true, local: lp, remote: rp });
        for (const f of await P(cb => sf.readdir(rp, cb))) await walk(rjoin(rp, f.filename), path.join(lp, safeName(f.filename)));
      } else list.push({ local: lp, remote: rp, size: st.size, mtime: st.mtime * 1000 });
    };
    for (const p of paths) await walk(p, path.join(localDir, safeName(p.replace(/\/+$/, '').split('/').pop() || 'root')));
    return list;
  }
  // Windows cannot store some characters that are fine on Linux
  const safeName = n => !IS_WIN ? (n.replace(/\x00/g, '_') || '_') : n.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, m => '_'.repeat(m.length)) || '_';

  ipcMain.handle('ssh:transfer', async (_e, sid, dir, paths, target, opts = {}) => {
    const s = sessions.get(sid);
    if (!s) return { error: 'Bağlantı kapalı.' };
    if (!Array.isArray(paths) || !paths.length) return { error: 'Seçili öğe yok.' };
    const id = 'x' + (++seq);
    const name = paths.length === 1 ? (dir === 'up' ? path.basename(paths[0]) : paths[0].split('/').pop()) : `${paths.length} öğe`;
    const j = { id, sid, wc: s.wc, dir, name, target, total: 0, done: 0, files: 0, filesDone: 0, current: '', state: 'preparing', started: Date.now(), overwrite: opts.overwrite || 'ask' };
    jobs.set(id, j);
    emitJob(j);
    runJob(s, j, paths).catch(() => {});
    return { id };
  });
  async function exists(sfOrNull, p) {
    if (sfOrNull) return P(cb => sfOrNull.stat(p, cb)).then(st => ({ size: st.size, mtime: st.mtime * 1000, dir: st.isDirectory() }), () => null);
    try { const st = fs.statSync(p); return { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() }; } catch (_) { return null; }
  }
  async function runJob(s, j, paths) {
    let lastT = Date.now(), lastB = 0;
    try {
      j.sf = await openSftp(s);
      const list = j.dir === 'up' ? await planUpload(paths, j.target) : await planDownload(j.sf, paths, j.target);
      j.total = list.reduce((a, x) => a + (x.size || 0), 0);
      j.files = list.filter(x => !x.dir).length;
      j.state = 'running'; emitJob(j);
      let tick = 0;
      for (const it of list) {
        if (j.canceled) break;
        if (it.dir) {
          if (j.dir === 'up') await P(cb => j.sf.mkdir(it.remote, cb)).catch(() => {});
          else await fs.promises.mkdir(it.local, { recursive: true });
          continue;
        }
        const dest = j.dir === 'up' ? it.remote : it.local;
        const ex = await exists(j.dir === 'up' ? j.sf : null, dest);
        if (ex && !ex.dir) {
          let ans = j.overwrite;
          if (ans === 'ask') {
            j.state = 'ask'; j.current = dest;
            out(j.wc, 'ssh:xferAsk', { id: j.id, file: dest, src: { size: it.size, mtime: it.mtime }, dst: ex });
            ans = await new Promise(r => { j.resolveAsk = r; });
            j.resolveAsk = null;
            if (ans === 'cancel') { cancelJob(j, ''); break; }
            if (ans === 'overwriteAll') j.overwrite = 'overwrite';
            if (ans === 'skipAll') j.overwrite = 'skip';
            if (ans === 'newerAll') j.overwrite = 'newer';
            j.state = 'running';
          }
          const mode = ans.replace(/All$/, '');
          if (mode === 'skip' || (mode === 'newer' && !(it.mtime > ex.mtime))) {
            j.done += it.size; j.filesDone++; j.skipped = (j.skipped || 0) + 1; emitJob(j); continue;
          }
        }
        j.current = j.dir === 'up' ? it.local : it.remote;
        emitJob(j);
        const base = j.done;
        const step = (sofar) => {
          j.done = base + sofar;
          const now = Date.now();
          if (now - lastT > 400) { j.speed = Math.round((j.done - lastB) * 1000 / (now - lastT)); lastT = now; lastB = j.done; }
          if (++tick % 8 === 0 || now - (j.lastEmit || 0) > 250) { j.lastEmit = now; emitJob(j); }
        };
        if (j.dir === 'up') {
          await P(cb => j.sf.fastPut(it.local, it.remote, { step: (t) => step(t), concurrency: 32 }, cb));
          if (it.mtime) await P(cb => j.sf.utimes(it.remote, Math.floor(Date.now() / 1000), Math.floor(it.mtime / 1000), cb)).catch(() => {});
        } else {
          await fs.promises.mkdir(path.dirname(it.local), { recursive: true });
          await P(cb => j.sf.fastGet(it.remote, it.local, { step: (t) => step(t), concurrency: 32 }, cb));
          if (it.mtime) { try { fs.utimesSync(it.local, new Date(), new Date(it.mtime)); } catch (_) {} }
        }
        j.done = base + it.size; j.filesDone++;
      }
      if (!j.canceled) j.state = 'done';
    } catch (e) {
      if (!j.canceled) { j.state = 'error'; j.error = sftpErr(e, j.current); }
    } finally {
      j.finished = true; j.current = '';
      try { if (j.sf) j.sf.end(); } catch (_) {}
      j.sf = null;
      emitJob(j);
      setTimeout(() => jobs.delete(j.id), 60000);
    }
  }

  /* ---------------- tunnels (local port forwarding) ---------------- */
  const tunnelList = s => s.tunnels.map(t => ({ localPort: t.localPort, remoteHost: t.remoteHost, remotePort: t.remotePort, conns: t.conns, error: t.error || '' }));
  function openTunnel(s, t) {
    return new Promise(resolve => {
      if (s.tunnels.some(x => x.localPort === t.localPort)) { resolve(`${t.localPort} zaten açık.`); return; }
      const rec = { ...t, conns: 0, server: null };
      const server = net.createServer(sock => {
        s.client.forwardOut('127.0.0.1', sock.remotePort || 0, t.remoteHost, t.remotePort, (err, stream) => {
          if (err) {
            sock.destroy();
            rec.error = /prohibited|denied/i.test(err.message) ? 'Sunucu port yönlendirmeye izin vermiyor (sshd_config: AllowTcpForwarding).' : 'Hedefe bağlanılamadı: ' + err.message;
            out(s.wc, 'ssh:tunnels', s.id, tunnelList(s));
            return;
          }
          rec.error = '';
          rec.conns++; out(s.wc, 'ssh:tunnels', s.id, tunnelList(s));
          sock.pipe(stream).pipe(sock);
          const end = () => { sock.destroy(); try { stream.close(); } catch (_) {} };
          sock.on('error', end); stream.on('error', end);
          stream.on('close', () => { sock.destroy(); rec.conns = Math.max(0, rec.conns - 1); out(s.wc, 'ssh:tunnels', s.id, tunnelList(s)); });
        });
      });
      server.once('error', e => resolve(e.code === 'EADDRINUSE' ? `Yerel port ${t.localPort} kullanımda.` : e.message));
      server.listen(t.localPort, '127.0.0.1', () => { rec.server = server; s.tunnels.push(rec); resolve(null); });
    });
  }
  ipcMain.handle('ssh:tunnel', async (_e, sid, action, t) => {
    const s = sessions.get(sid); if (!s) return { error: 'Bağlantı kapalı.' };
    if (action === 'open') {
      const [c] = cleanTunnels([t]);
      if (!c) return { error: 'Port numaraları geçersiz.' };
      const err = await openTunnel(s, c);
      if (err) return { error: err };
    } else if (action === 'close') {
      const i = s.tunnels.findIndex(x => x.localPort === t.localPort);
      if (i >= 0) { try { s.tunnels[i].server.close(); } catch (_) {} s.tunnels.splice(i, 1); }
    }
    return { tunnels: tunnelList(s) };
  });

  /* ---------------- RDP ---------------- */
  ipcMain.handle('ssh:rdp', async (_e, hostId, given) => {
    const h = hostById(hostId); if (!h) return { error: 'Bağlantı bulunamadı.' };
    if (IS_MAC) { // Windows App (Microsoft Remote Desktop) opens rdp:// links
      const q = [`full address=s:${h.host}:${h.port || 3389}`];
      if (h.user) q.push(`username=s:${h.domain ? h.domain + '\\' : ''}${h.user}`);
      if (h.fullscreen) q.push('screen mode id=i:2');
      try { await shell.openExternal('rdp://' + q.map(x => encodeURIComponent(x).replace(/%3D/g, '=').replace(/%3A/g, ':')).join('&')); }
      catch (_) { return { error: 'Windows App (Microsoft Remote Desktop) bulunamadı; App Store’dan kurabilirsin.' }; }
      return { ok: true };
    }
    if (!IS_WIN) return require('./rdp').openLinux(h, typeof given === 'string' ? given : secretOf(h, 'pw')); // FreeRDP / Remmina
    const target = h.port && h.port !== 3389 ? `${h.host}:${h.port}` : h.host;
    const pw = typeof given === 'string' ? given : secretOf(h, 'pw');
    const user = h.user ? (h.domain ? `${h.domain}\\${h.user}` : h.user) : '';
    // hand the credentials to Windows the way "Remember me" in mstsc does
    if (user && pw) {
      await new Promise(res => execFile('cmdkey', [`/generic:TERMSRV/${h.host}`, `/user:${user}`, `/pass:${pw}`], { windowsHide: true }, () => res()));
    }
    const args = [`/v:${target}`];
    if (h.fullscreen) args.push('/f');
    if (h.admin) args.push('/admin');
    try {
      const p = spawn('mstsc.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
      p.on('error', () => {});
      p.unref();
    } catch (e) { return { error: e.message }; }
    return { ok: true };
  });

  /* ---------------- Claude / Codex (agentlink.js) ----------------
     The agent gives a host id and a command; the connection is made here with the saved secrets
     (or the ones given in this run) and only the output goes back. One client per host, shared by
     the sessions and closed after a while without use. */
  const agentConns = new Map(); // hostId -> { ready: Promise<client>, dead, last }
  const AGENT_IDLE = 10 * 60 * 1000;
  function dropAgent(id) { const x = agentConns.get(id); if (!x) return; agentConns.delete(id); x.dead = true; x.ready.then(c => { try { c.end(); } catch (_) {} }, () => {}); }
  setInterval(() => {
    for (const [id, x] of agentConns) if (!x.busy && Date.now() - x.last > AGENT_IDLE) { agentConns.delete(id); x.ready.then(c => { try { c.end(); } catch (_) {} }, () => {}); }
  }, 60 * 1000).unref();
  function agentClient(h) {
    const old = agentConns.get(h.id);
    if (old && !old.dead) return old.ready;
    const x = { dead: false, last: Date.now(), busy: 0 };
    x.ready = connectClient(h, {}, () => { x.dead = true; if (agentConns.get(h.id) === x) agentConns.delete(h.id); }).then(r => {
      if (r.client) { r.client.on('error', () => {}); return r.client; }
      x.dead = true;
      if (r.needPassword) throw new Error(`“${h.name || 'Bu sunucu'}” için ${r.what === 'pp' ? 'anahtar parolası' : 'parola'} kayıtlı değil. Kullanıcının VoxStorm’un SSH modunda bu sunucuya bir kez bağlanması gerekiyor; sonra bu çalışma boyunca kullanılabilir.`);
      if (r.hostKey) throw new Error(`Sunucunun anahtarı ${r.changed ? 'değişmiş' : 'henüz onaylanmamış'}. Kullanıcının VoxStorm’un SSH modunda bu sunucuya bir kez bağlanıp anahtarı onaylaması gerekiyor.`);
      throw new Error(r.error || 'Bağlanılamadı.');
    });
    x.ready.catch(() => { if (agentConns.get(h.id) === x) agentConns.delete(h.id); });
    agentConns.set(h.id, x);
    return x.ready;
  }
  async function agentExec(hostId, cmd, { stdin, timeout = 120000, maxBytes = 1024 * 1024 } = {}) {
    const h = hostById(hostId);
    if (!h || h.kind !== 'ssh') throw new Error('Sunucu bulunamadı.');
    if (h.aiAccess === 'deny') throw new Error('Bu sunucu ajanlara kapalı.');
    const c = await agentClient(h);
    const x = agentConns.get(h.id) || { busy: 0 };
    x.busy++; x.last = Date.now();
    try {
      return await new Promise((resolve, reject) => {
        c.exec(cmd, (err, stream) => {
          if (err) { reject(new Error('Komut başlatılamadı: ' + err.message)); return; }
          const out1 = [], out2 = []; let n1 = 0, n2 = 0, done = false, cut = false;
          const fin = code => {
            if (done) return; done = true; clearTimeout(t);
            resolve({ code, cut, stdout: Buffer.concat(out1).toString('utf8'), stderr: Buffer.concat(out2).toString('utf8') });
          };
          const t = setTimeout(() => { try { stream.signal('KILL'); } catch (_) {} try { stream.close(); } catch (_) {} fin(-2); }, timeout);
          stream.on('data', d => { n1 += d.length; if (n1 <= maxBytes) out1.push(d); else cut = true; });
          stream.stderr.on('data', d => { n2 += d.length; if (n2 <= maxBytes / 4) out2.push(d); });
          stream.on('exit', code => { stream.exitCode = code; });
          stream.on('close', () => fin(stream.exitCode == null ? 0 : stream.exitCode));
          if (typeof stdin === 'string' && stdin) stream.end(stdin); else stream.end();
        });
      });
    } finally { x.busy--; x.last = Date.now(); }
  }
  // SFTP for agents: 'get' copies remote -> local, 'put' local -> remote
  async function agentSftp(hostId, op, local, remote) {
    const h = hostById(hostId);
    if (!h || h.kind !== 'ssh' || h.aiAccess === 'deny') throw new Error('Sunucu bulunamadı.');
    const c = await agentClient(h);
    const sf = await new Promise((res, rej) => c.sftp((e, x) => (e ? rej(e) : res(x))));
    try { await new Promise((res, rej) => (op === 'put' ? sf.fastPut : sf.fastGet).call(sf, op === 'put' ? local : remote, op === 'put' ? remote : local, e => (e ? rej(e) : res()))); }
    finally { try { sf.end(); } catch (_) {} }
  }
  // what an agent may see: no host name, user, port or secret
  const agentList = () => hosts().filter(h => h.kind === 'ssh' && h.aiAccess !== 'deny').map(h => ({
    id: h.id, name: h.name || `Adsız sunucu ${h.id}`, group: h.group, aiAccess: h.aiAccess || '', label: label(h),
  }));
  function setAiAccess(id, v) {
    const h = hostById(id); if (!h) return;
    h.aiAccess = ['allow', 'deny'].includes(v) ? v : '';
    write('hosts', true);
  }

  return {
    agentList, agentExec, agentSftp, setAiAccess,
    addChannel, execPty, execOut, execStream,
    hasSession: sid => sessions.has(sid),
    sessionWc: sid => (sessions.get(sid) || {}).wc,
    hostLabel: sid => { const x = sessions.get(sid); const h = x && hostById(x.hostId); return h ? label(h) : ''; },
    shutdown() {
      for (const sid of [...sessions.keys()]) closeSession(sid, '');
      for (const x of agentConns.values()) x.ready.then(c => { try { c.end(); } catch (_) {} }, () => {});
      agentConns.clear();
      writeNow('state');
    },
  };
};
