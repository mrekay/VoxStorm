// VoxStorm — IDE deployment (like PhpStorm's Deployment): FTP, FTPS and SFTP servers, per-project
// mappings (local folder <-> remote folder), excluded paths, upload / download, "compare and sync"
// and automatic upload (on save, or on every change in the project — Claude's edits included).
// The remote host browser of the IDE (renderer/ftp.js) runs on the same connections.
// Claude / Codex reach these servers through VoxStorm (agentlink.js): they see ids and names only.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const I18N = require('../i18n/i18n.js'); const __ = I18N.t;

const DEFAULT_EXCLUDES = ['.git', '.svn', '.hg', 'node_modules', '.idea', '.vscode', '.vs', '.DS_Store', 'Thumbs.db'];
const MAX_WALK = 30000; // files walked on one side of a sync
const IDLE_MS = 120000; // an unused connection is closed after this

module.exports = function setupFtp({ ipcMain, DATA, sendTo, getWin, insideProject }) {
  const FILE = path.join(DATA, 'ftp.json');
  const SYNC_DIR = path.join(DATA, 'ftp-sync');
  let data = { servers: [], deploy: {} };
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (d && Array.isArray(d.servers)) data = { servers: d.servers, deploy: d.deploy || {} }; } catch (_) {}
  let wT = null;
  const write = now => {
    clearTimeout(wT);
    const go = () => { try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8'); fs.renameSync(tmp, FILE); } catch (_) {} };
    if (now) go(); else wT = setTimeout(go, 400);
  };
  const servers = () => data.servers;
  const srvById = id => servers().find(s => s.id === id);
  const newId = () => crypto.randomUUID().slice(0, 12);
  const send = (ch, ...a) => { const w = getWin(); if (w && !w.isDestroyed()) sendTo(w.webContents, ch, ...a); };
  const normP = p => path.resolve(p).toLowerCase();

  /* ---------------- secrets ---------------- */
  const mem = new Map(); // `${id}:pw` / `${id}:pp`
  const canEncrypt = () => require('./platform').canEncrypt(safeStorage);
  const encrypt = s => safeStorage.encryptString(String(s)).toString('base64');
  const decrypt = b => { try { return safeStorage.decryptString(Buffer.from(b, 'base64')); } catch (_) { return null; } };
  function secretOf(s, kind) {
    const k = `${s.id}:${kind}`;
    if (mem.has(k)) return mem.get(k);
    const stored = kind === 'pw' ? s.pwd : s.pph;
    return stored ? decrypt(stored) : null;
  }
  const publicSrv = s => { const { pwd, pph, ...rest } = s; return { ...rest, hasPassword: !!pwd || mem.has(s.id + ':pw'), hasPassphrase: !!pph || mem.has(s.id + ':pp') }; };
  const TYPES = ['ftp', 'ftps', 'ftps-implicit', 'sftp'];
  const TYPE_NAME = { ftp: 'FTP', ftps: 'FTPS', 'ftps-implicit': 'FTPS (implicit)', sftp: 'SFTP' };
  const posix = p => String(p || '').replace(/\\/g, '/');
  // a remote path: absolute, single slashes, no trailing slash (except "/")
  const rnorm = p => { let x = ('/' + posix(p)).replace(/\/+/g, '/'); const out = []; for (const part of x.split('/')) { if (!part || part === '.') continue; if (part === '..') out.pop(); else out.push(part); } return '/' + out.join('/'); };
  const rjoin = (...a) => rnorm(a.filter(x => x != null && x !== '').join('/'));
  function clean(d) {
    const s = v => (typeof v === 'string' ? v.trim() : '');
    const type = TYPES.includes(d.type) ? d.type : 'ftp';
    const port = parseInt(d.port, 10);
    return {
      type,
      name: s(d.name).slice(0, 80),
      host: s(d.host).slice(0, 255),
      port: port > 0 && port < 65536 ? port : (type === 'sftp' ? 22 : type === 'ftps-implicit' ? 990 : 21),
      user: s(d.user).slice(0, 128),
      auth: type === 'sftp' && ['password', 'key', 'agent'].includes(d.auth) ? d.auth : 'password',
      keyPath: s(d.keyPath).slice(0, 1024),
      root: rnorm(s(d.root) || '/'),
      webUrl: s(d.webUrl).slice(0, 500),
      insecure: !!d.insecure, // FTPS: accept a self-signed certificate
      timeMode: d.timeMode === 'off' ? 'off' : 'keep', // keep the local modification time on upload
      askPassword: !!d.askPassword,
      group: s(d.group).slice(0, 60),
      aiAccess: ['allow', 'deny'].includes(d.aiAccess) ? d.aiAccess : '',
      color: /^[a-z]{0,12}$/.test(d.color || '') ? d.color || '' : '',
    };
  }
  const label = s => s.name || `${s.user ? s.user + '@' : ''}${s.host}`;

  /* ---------------- connections ---------------- */
  // id -> { kind, c (basic-ftp Client | ssh2 Client), sftp, chain (one op at a time), last, ready }
  const pool = new Map();
  setInterval(() => { for (const [id, x] of pool) if (!x.busy && Date.now() - x.last > IDLE_MS) drop(id); }, 30000).unref();
  function drop(id) {
    const x = pool.get(id); if (!x) return;
    pool.delete(id);
    x.ready.then(a => a.close(), () => {});
    send('ftp:state', { id, connected: false });
  }
  function readKey(s) {
    if (!s.keyPath) throw new Error(__('Özel anahtar dosyası seçilmedi.'));
    const p = s.keyPath.replace(/^~(?=[\\/]|$)/, os.homedir());
    try { return fs.readFileSync(p); } catch (_) { throw new Error(__('Anahtar dosyası okunamadı: {path}', { path: p })); }
  }
  async function openFtp(s, pw) {
    const ftp = require('basic-ftp');
    const c = new ftp.Client(30000);
    c.ftp.verbose = false;
    const secure = s.type === 'ftps' ? true : s.type === 'ftps-implicit' ? 'implicit' : false;
    await c.access({ host: s.host, port: s.port, user: s.user || 'anonymous', password: pw || (s.user ? '' : 'anonymous@'), secure, secureOptions: secure ? { rejectUnauthorized: !s.insecure } : undefined });
    try { await c.send('OPTS UTF8 ON', true); } catch (_) {}
    let mfmt = false; try { mfmt = (await c.features()).has('MFMT'); } catch (_) {}
    const ensureConn = () => { if (c.closed) throw new Error(__('Bağlantı koptu.')); };
    return {
      close: () => { try { c.close(); } catch (_) {} },
      get closed() { return c.closed; },
      async list(dir) {
        ensureConn();
        const l = await c.list(dir);
        return l.filter(f => f.name !== '.' && f.name !== '..').map(f => ({ name: f.name, dir: f.isDirectory, link: f.isSymbolicLink, size: f.size || 0, mtime: f.modifiedAt ? f.modifiedAt.getTime() : null, raw: f.rawModifiedAt || '' }));
      },
      async get(remote, local) { ensureConn(); await c.downloadTo(local, remote); },
      async put(local, remote, mtime) {
        ensureConn();
        await c.uploadFrom(local, remote);
        if (mtime && mfmt && s.timeMode !== 'off') { const d = new Date(mtime); const t = d.toISOString().replace(/[-:T]/g, '').slice(0, 14); try { await c.send(`MFMT ${t} ${remote}`, true); } catch (_) {} }
      },
      async putBuffer(buf, remote) { ensureConn(); const { Readable } = require('stream'); await c.uploadFrom(Readable.from(buf), remote); },
      async getBuffer(remote, max) {
        ensureConn();
        const { Writable } = require('stream');
        const parts = []; let n = 0;
        const w = new Writable({ write(ch, _e, cb) { n += ch.length; if (n > max) cb(new Error(__('Dosya çok büyük.'))); else { parts.push(ch); cb(); } } });
        await c.downloadTo(w, remote);
        return Buffer.concat(parts);
      },
      async mkdirp(dir) { ensureConn(); await c.ensureDir(dir); await c.cd('/'); },
      async remove(p, isDir) { ensureConn(); if (isDir) await c.removeDir(p); else await c.remove(p); },
      async rename(a, b) { ensureConn(); await c.rename(a, b); },
      async stat(p) {
        ensureConn();
        // a file: SIZE + MDTM (cheap); a folder or a server without them: the parent's listing
        try {
          const size = await c.size(p);
          let mtime = null; try { mtime = (await c.lastMod(p)).getTime(); } catch (_) {}
          return { name: path.posix.basename(p), dir: false, size, mtime };
        } catch (_) {}
        const dir = path.posix.dirname(p), base = path.posix.basename(p);
        try { const l = await this.list(dir); return l.find(f => f.name === base) || null; } catch (_) { return null; }
      },
    };
  }
  function openSftp(s, pw, pp) {
    return new Promise((resolve, reject) => {
      const { Client } = require('ssh2');
      const c = new Client();
      const cfg = { host: s.host, port: s.port, username: s.user || os.userInfo().username, readyTimeout: 20000, keepaliveInterval: 20000, tryKeyboard: true };
      if (s.auth === 'password') cfg.password = pw || '';
      else if (s.auth === 'key') { try { cfg.privateKey = readKey(s); } catch (e) { reject(e); return; } if (pp) cfg.passphrase = pp; }
      else { const pipe = '\\\\.\\pipe\\openssh-ssh-agent'; cfg.agent = process.platform !== 'win32' ? process.env.SSH_AUTH_SOCK : (fs.existsSync(pipe) ? pipe : 'pageant'); }
      // the host key is checked by the SSH mode when the server is also saved there; here it is trusted on first use
      const KNOWN = path.join(DATA, 'ftp-known.json');
      let known = {}; try { known = JSON.parse(fs.readFileSync(KNOWN, 'utf8')); } catch (_) {}
      let hostErr = null, hostKey = null;
      cfg.hostVerifier = key => {
        const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        const k = `${s.host.toLowerCase()}:${s.port}`;
        if (!known[k]) { known[k] = fp; try { fs.writeFileSync(KNOWN, JSON.stringify(known, null, 1)); } catch (_) {} return true; }
        if (known[k] === fp) return true;
        hostErr = __('Sunucunun anahtarı değişmiş ({fp}). Beklenen bir değişiklikse sunucu ayarlarında “Bağlantıyı dene” ile yeni anahtarı onayla.', { fp });
        hostKey = { host: s.host, port: s.port, fp, old: known[k] };
        return false;
      };
      c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw || '')));
      c.on('ready', () => c.sftp((e, sf) => {
        if (e) { c.end(); reject(e); return; }
        const P = fn => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));
        let closed = false; c.on('close', () => { closed = true; });
        const api = {
          close: () => { try { c.end(); } catch (_) {} },
          get closed() { return closed; },
          async list(dir) {
            const l = await P(cb => sf.readdir(dir, cb));
            return l.filter(f => f.filename !== '.' && f.filename !== '..').map(f => ({ name: f.filename, dir: f.attrs.isDirectory(), link: f.attrs.isSymbolicLink(), size: f.attrs.size || 0, mtime: (f.attrs.mtime || 0) * 1000 }));
          },
          get: (remote, local) => P(cb => sf.fastGet(remote, local, cb)),
          async put(local, remote, mtime) {
            await P(cb => sf.fastPut(local, remote, cb));
            if (mtime && s.timeMode !== 'off') { const t = Math.floor(mtime / 1000); try { await P(cb => sf.utimes(remote, t, t, cb)); } catch (_) {} }
          },
          putBuffer: (buf, remote) => P(cb => sf.writeFile(remote, buf, cb)),
          async getBuffer(remote, max) {
            const st = await P(cb => sf.stat(remote, cb));
            if (st.size > max) throw new Error(__('Dosya çok büyük.'));
            return P(cb => sf.readFile(remote, cb));
          },
          async mkdirp(dir) {
            let cur = '';
            for (const part of dir.split('/').filter(Boolean)) {
              cur += '/' + part;
              try { await P(cb => sf.stat(cur, cb)); } catch (_) { await P(cb => sf.mkdir(cur, cb)); }
            }
          },
          async remove(p, isDir) {
            if (!isDir) return P(cb => sf.unlink(p, cb));
            for (const f of await api.list(p)) await api.remove(p.replace(/\/$/, '') + '/' + f.name, f.dir && !f.link);
            return P(cb => sf.rmdir(p, cb));
          },
          rename: (a, b) => P(cb => sf.rename(a, b, cb)),
          async stat(p) { try { const a = await P(cb => sf.lstat(p, cb)); return { name: path.posix.basename(p), dir: a.isDirectory(), size: a.size, mtime: a.mtime * 1000 }; } catch (_) { return null; } },
        };
        resolve(api);
      }));
      c.on('error', e => { const x = new Error(hostErr || e.message); if (hostKey) x.hostKey = hostKey; reject(x); });
      c.connect(cfg);
    });
  }
  // opts.password: a password typed for this run (remembered in memory)
  function conn(id, opts = {}) {
    const s = srvById(id);
    if (!s) return Promise.reject(new Error(__('Sunucu bulunamadı.')));
    if (typeof opts.password === 'string') mem.set(s.id + ':pw', opts.password);
    let x = pool.get(id);
    if (x) {
      return x.ready.then(a => { if (a.closed) { pool.delete(id); return conn(id); } return a; });
    }
    const pw = secretOf(s, 'pw'), pp = secretOf(s, 'pp');
    if (s.auth === 'password' && s.user && pw == null) {
      const e = new Error(__('Parola gerekli.')); e.needPassword = true; return Promise.reject(e);
    }
    x = { busy: 0, last: Date.now(), chain: Promise.resolve() };
    x.ready = (s.type === 'sftp' ? openSftp(s, pw, pp) : openFtp(s, pw)).catch(e => {
      pool.delete(id);
      const msg = String((e && e.message) || e);
      const err = new Error(/530|login|auth|password|All configured authentication methods failed/i.test(msg) ? __('Giriş başarısız: kullanıcı adı ya da parola yanlış. ({msg})', { msg }) : msg);
      if (/530|login incorrect|authentication methods failed/i.test(msg)) err.needPassword = true;
      throw err;
    });
    pool.set(id, x);
    x.ready.then(() => send('ftp:state', { id, connected: true }), () => {});
    return x.ready;
  }
  // one operation at a time per connection (FTP is a single command channel)
  function run(id, fn, opts) {
    return conn(id, opts).then(a => {
      const x = pool.get(id);
      const p = x.chain.then(() => { x.busy++; return fn(a); }).finally(() => { x.busy--; x.last = Date.now(); });
      x.chain = p.catch(() => {});
      return p;
    });
  }

  /* ---------------- deployment config (per project) ---------------- */
  // deploy[normPath] = { server, auto: 'off' | 'save' | 'always', excludes: [], maps: { [serverId]: [{ local, remote }] }, delRemote }
  function depOf(root) {
    const k = normP(root);
    return data.deploy[k] || { server: '', auto: 'off', excludes: DEFAULT_EXCLUDES.slice(), maps: {}, delRemote: false };
  }
  function setDep(root, d) {
    const k = normP(root), cur = depOf(root);
    const maps = {};
    for (const [sid, list] of Object.entries((d && d.maps) || cur.maps || {})) {
      if (!srvById(sid) || !Array.isArray(list)) continue;
      maps[sid] = list.slice(0, 20).map(m => ({ local: posix(m.local || '').replace(/^\/+|\/+$/g, ''), remote: posix(m.remote || '').trim() || '/' }));
    }
    data.deploy[k] = {
      root: path.resolve(root),
      server: d && srvById(d.server) ? d.server : '',
      auto: ['off', 'save', 'always'].includes(d && d.auto) ? d.auto : 'off',
      excludes: (Array.isArray(d && d.excludes) ? d.excludes : cur.excludes).map(x => String(x).trim()).filter(Boolean).slice(0, 200),
      maps,
      delRemote: !!(d && d.delRemote),
    };
    write();
    watchAll();
    return data.deploy[k];
  }
  const mapsFor = (root, sid) => { const m = depOf(root).maps[sid]; return m && m.length ? m : [{ local: '', remote: '/' }]; };
  // glob-ish exclude test on a project-relative path ("a/b/c.txt"): a name, a path, or *.ext
  function excluded(rel, excludes) {
    const parts = rel.split('/');
    for (const raw of excludes) {
      const ex = posix(raw).replace(/^\/+|\/+$/g, '');
      if (!ex) continue;
      if (ex.includes('*')) {
        const re = new RegExp('^' + ex.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$', 'i');
        if (parts.some(p => re.test(p)) || re.test(rel)) return true;
      } else if (ex.includes('/')) { if (rel === ex || rel.startsWith(ex + '/')) return true; }
      else if (parts.includes(ex)) return true;
    }
    return false;
  }
  // a local file -> { server, remote, rel, map } through the project's mapping, or null
  function resolveLocal(root, file, sid) {
    const d = depOf(root); sid = sid || d.server;
    const s = srvById(sid); if (!s) return null;
    const rel = posix(path.relative(root, file));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (excluded(rel, d.excludes)) return null;
    let best = null;
    for (const m of mapsFor(root, sid)) {
      if (m.local === '' || rel === m.local || rel.startsWith(m.local + '/')) if (!best || m.local.length > best.local.length) best = m;
    }
    if (!best) return null;
    const sub = best.local ? rel.slice(best.local.length).replace(/^\//, '') : rel;
    return { server: s, remote: rjoin(s.root, best.remote, sub), rel, map: best };
  }
  // a remote path -> the local file it maps to, or null
  function resolveRemote(root, sid, remote) {
    const s = srvById(sid); if (!s) return null;
    remote = rnorm(remote);
    let best = null, bestBase = '';
    for (const m of mapsFor(root, sid)) {
      const base = rjoin(s.root, m.remote);
      if (remote === base || remote.startsWith(base === '/' ? '/' : base + '/')) if (!best || base.length > bestBase.length) { best = m; bestBase = base; }
    }
    if (!best) return null;
    const sub = remote.slice(bestBase.length).replace(/^\//, '');
    return path.join(root, ...(best.local ? best.local.split('/') : []), ...(sub ? sub.split('/') : []));
  }

  /* ---------------- sync records ---------------- */
  // what both sides looked like after the last transfer: tells "changed here" from "changed there"
  const recFile = (root, sid) => path.join(SYNC_DIR, crypto.createHash('sha1').update(normP(root) + '|' + sid).digest('hex').slice(0, 20) + '.json');
  const recs = new Map();
  function recOf(root, sid) {
    const f = recFile(root, sid);
    if (!recs.has(f)) { let r = {}; try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} recs.set(f, { f, r, t: null }); }
    return recs.get(f);
  }
  function recSet(root, sid, rel, v) {
    const x = recOf(root, sid);
    if (v) x.r[rel] = v; else delete x.r[rel];
    clearTimeout(x.t);
    x.t = setTimeout(() => { try { fs.mkdirSync(SYNC_DIR, { recursive: true }); fs.writeFileSync(x.f, JSON.stringify(x.r)); } catch (_) {} }, 800);
  }

  /* ---------------- transfers ---------------- */
  async function uploadFile(root, file, sid, { quiet } = {}) {
    const t = resolveLocal(root, file, sid);
    if (!t) throw new Error(__('Bu dosya için eşleme yok ya da hariç tutulmuş: {path}', { path: file }));
    const st = await fsp.stat(file);
    await run(t.server.id, async a => {
      try { await a.put(file, t.remote, st.mtimeMs); } catch (e) {
        await a.mkdirp(path.posix.dirname(t.remote));
        await a.put(file, t.remote, st.mtimeMs);
      }
      const r = await a.stat(t.remote).catch(() => null);
      recSet(root, t.server.id, t.rel, { ls: st.size, lm: Math.round(st.mtimeMs), rs: r ? r.size : st.size, rm: r && r.mtime ? r.mtime : null });
    });
    if (!quiet) send('ftp:log', { kind: 'up', server: t.server.id, local: file, remote: t.remote });
    return t.remote;
  }
  async function downloadFile(root, sid, remote, local) {
    local = local || resolveRemote(root, sid, remote);
    if (!local) throw new Error(__('Bu uzak yol projede bir klasöre eşlenmemiş: {path}', { path: remote }));
    if (!insideProject(local)) throw new Error(__('Proje dışında'));
    await fsp.mkdir(path.dirname(local), { recursive: true });
    const r = await run(sid, async a => { await a.get(remote, local + '.vxpart'); return a.stat(remote).catch(() => null); });
    await fsp.rename(local + '.vxpart', local);
    if (r && r.mtime) { const t = new Date(r.mtime); try { await fsp.utimes(local, t, t); } catch (_) {} }
    const st = await fsp.stat(local);
    const rel = posix(path.relative(root, local));
    recSet(root, sid, rel, { ls: st.size, lm: Math.round(st.mtimeMs), rs: r ? r.size : st.size, rm: r && r.mtime ? r.mtime : null });
    send('ftp:log', { kind: 'down', server: sid, local, remote });
    return local;
  }
  // every file under a local folder (relative to the project root), excludes applied
  async function walkLocal(root, dir, excludes, out = []) {
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents) {
      if (out.length >= MAX_WALK) break;
      const fp = path.join(dir, e.name), rel = posix(path.relative(root, fp));
      if (excluded(rel, excludes)) continue;
      if (e.isDirectory()) await walkLocal(root, fp, excludes, out);
      else if (e.isFile()) { try { const st = await fsp.stat(fp); out.push({ rel, size: st.size, mtime: Math.round(st.mtimeMs) }); } catch (_) {} }
    }
    return out;
  }
  async function walkRemote(a, base, sub, excludes, relBase, out = [], stop) {
    if (stop && stop()) return out;
    let l; try { l = await a.list(rjoin(base, sub)); } catch (_) { return out; }
    for (const f of l) {
      if (out.length >= MAX_WALK) break;
      const relSub = sub ? sub + '/' + f.name : f.name;
      const rel = relBase ? relBase + '/' + relSub : relSub;
      if (excluded(rel, excludes)) continue;
      if (f.dir) await walkRemote(a, base, relSub, excludes, relBase, out, stop);
      else if (!f.link) out.push({ rel, size: f.size, mtime: f.mtime, remote: rjoin(base, relSub) });
    }
    return out;
  }
  /* compare a project folder (or the whole mapping) with the server.
     state: same | local-new | remote-new | local-changed | remote-changed | conflict | local-only | remote-only */
  async function compare(root, sid, sub) {
    const d = depOf(root), s = srvById(sid);
    if (!s) throw new Error(__('Sunucu bulunamadı.'));
    sub = posix(sub || '').replace(/^\/+|\/+$/g, '');
    const rec = recOf(root, sid).r;
    const local = new Map(), remote = new Map();
    for (const m of mapsFor(root, sid)) {
      // the part of this mapping inside the folder asked for
      let lsub;
      if (!sub) lsub = m.local;
      else if (m.local === '' || sub === m.local || sub.startsWith(m.local + '/')) lsub = sub;
      else if (m.local.startsWith(sub + '/')) lsub = m.local;
      else continue;
      const ldir = path.join(root, ...(lsub ? lsub.split('/') : []));
      for (const f of await walkLocal(root, ldir, d.excludes)) local.set(f.rel, f);
      const inMap = m.local ? lsub.slice(m.local.length).replace(/^\//, '') : lsub;
      const rbase = rjoin(s.root, m.remote, inMap);
      const rl = await run(sid, a => walkRemote(a, rbase, '', d.excludes, lsub));
      for (const f of rl) remote.set(f.rel, f);
    }
    const out = [];
    for (const rel of new Set([...local.keys(), ...remote.keys()])) {
      const l = local.get(rel), r = remote.get(rel), was = rec[rel];
      let state;
      if (l && !r) state = was ? 'remote-deleted' : 'local-only';
      else if (!l && r) state = was ? 'local-deleted' : 'remote-only';
      else {
        const lCh = was ? (l.size !== was.ls || Math.abs(l.mtime - was.lm) > 2000) : null;
        const rCh = was ? (r.size !== was.rs || (r.mtime && was.rm && Math.abs(r.mtime - was.rm) > 2000)) : null;
        if (was) state = lCh && rCh ? 'conflict' : lCh ? 'local-changed' : rCh ? 'remote-changed' : 'same';
        // never synced through VoxStorm: the size decides, the newer side wins
        else state = l.size === r.size ? 'same' : (r.mtime && r.mtime > l.mtime + 2000 ? 'remote-changed' : 'local-changed');
      }
      out.push({ rel, state, lsize: l ? l.size : null, lmtime: l ? l.mtime : null, rsize: r ? r.size : null, rmtime: r ? r.mtime : null, remote: r ? r.remote : (resolveLocal(root, path.join(root, rel), sid) || {}).remote });
    }
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    return { items: out, cut: local.size >= MAX_WALK || remote.size >= MAX_WALK };
  }
  // carry out the chosen actions: [{ rel, act: 'up' | 'down' | 'delRemote' | 'delLocal' }]
  const jobs = new Map();
  async function syncRun(root, sid, list, jobId) {
    const job = { cancel: false }; jobs.set(jobId, job);
    let done = 0, failed = 0; const errors = [];
    try {
      for (const it of list) {
        if (job.cancel) break;
        const local = path.join(root, ...it.rel.split('/'));
        send('ftp:progress', { job: jobId, done, total: list.length, rel: it.rel });
        try {
          if (it.act === 'up') await uploadFile(root, local, sid, { quiet: true });
          else if (it.act === 'down') await downloadFile(root, sid, it.remote || resolveLocal(root, local, sid).remote, local);
          else if (it.act === 'delRemote') { const t = it.remote || resolveLocal(root, local, sid).remote; await run(sid, a => a.remove(t, false)); recSet(root, sid, it.rel, null); }
          else if (it.act === 'delLocal') { if (!insideProject(local)) throw new Error(__('Proje dışında')); await require('electron').shell.trashItem(local).catch(() => fsp.unlink(local)); recSet(root, sid, it.rel, null); }
          else if (it.act === 'mark') { // "same": remember both sides as they are
            const st = await fsp.stat(local); recSet(root, sid, it.rel, { ls: st.size, lm: Math.round(st.mtimeMs), rs: it.rsize, rm: it.rmtime });
          }
          done++;
        } catch (e) { failed++; errors.push(`${it.rel}: ${e.message}`); }
      }
    } finally { jobs.delete(jobId); }
    send('ftp:progress', { job: jobId, done, total: list.length, end: true, failed });
    return { done, failed, errors: errors.slice(0, 30), cancelled: job.cancel };
  }

  /* ---------------- automatic upload ---------------- */
  // 'save': the IDE tells us (ftp:saved). 'always': a watcher on the project uploads every change.
  const watchers = new Map(); // normRoot -> { w, timers }
  function watchAll() {
    const want = new Set();
    for (const d of Object.values(data.deploy)) if (d.auto === 'always' && d.server && d.root && fs.existsSync(d.root)) want.add(normP(d.root));
    for (const [k, x] of watchers) if (!want.has(k)) { try { x.w.close(); } catch (_) {} watchers.delete(k); }
    for (const d of Object.values(data.deploy)) {
      const k = d.root && normP(d.root);
      if (!k || !want.has(k) || watchers.has(k)) continue;
      const root = d.root, timers = new Map();
      let w; try { w = fs.watch(root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const fp = path.join(root, String(name));
        const rel = posix(String(name));
        if (excluded(rel, depOf(root).excludes) || /\.vxpart$|~$|\.swp$/.test(rel)) return;
        clearTimeout(timers.get(fp));
        timers.set(fp, setTimeout(() => { timers.delete(fp); autoOne(root, fp, true); }, 700));
      }); } catch (_) { continue; }
      w.on('error', () => {});
      watchers.set(k, { w, timers });
    }
  }
  const recent = new Map(); // file -> mtime last uploaded (a save and the watcher must not upload twice)
  async function autoOne(root, fp, fromWatch) {
    const d = depOf(root);
    if (!d.server || d.auto === 'off' || (fromWatch && d.auto !== 'always')) return;
    let st; try { st = await fsp.stat(fp); } catch (_) {
      if (fromWatch && d.delRemote) { const t = resolveLocal(root, fp, d.server); if (t) run(d.server, a => a.remove(t.remote, false)).then(() => { recSet(root, d.server, t.rel, null); send('ftp:log', { kind: 'del', server: d.server, local: fp, remote: t.remote }); }, () => {}); }
      return;
    }
    if (!st.isFile()) return;
    if (recent.get(fp) === st.mtimeMs) return;
    recent.set(fp, st.mtimeMs); if (recent.size > 500) recent.delete(recent.keys().next().value);
    if (!resolveLocal(root, fp, d.server)) return;
    try { await uploadFile(root, fp, d.server); } catch (e) { send('ftp:log', { kind: 'error', server: d.server, local: fp, error: e.message }); }
  }

  /* ---------------- IPC ---------------- */
  const H = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { error: String((e && e.message) || e), needPassword: !!(e && e.needPassword), hostKey: (e && e.hostKey) || undefined }; } });
  // the user accepted a changed SFTP host key (asked in the server dialog after "Bağlantıyı dene")
  H('ftp:trustKey', (host, port, fp) => {
    const KNOWN = path.join(DATA, 'ftp-known.json');
    let known = {}; try { known = JSON.parse(fs.readFileSync(KNOWN, 'utf8')); } catch (_) {}
    known[`${String(host).toLowerCase()}:${port}`] = String(fp);
    fs.writeFileSync(KNOWN, JSON.stringify(known, null, 1));
    return true;
  });
  H('ftp:list', () => ({ servers: servers().map(publicSrv), canEncrypt: canEncrypt(), types: TYPE_NAME }));
  H('ftp:save', d => {
    const v = clean(d || {});
    if (!v.host) throw new Error(__('Sunucu adresi boş olamaz.'));
    let s = d.id && srvById(d.id);
    if (s) { Object.assign(s, v); drop(s.id); } else { s = { id: newId(), ...v }; servers().push(s); }
    if (typeof d.pw === 'string' && d.pw) { mem.set(s.id + ':pw', d.pw); if (!d.askPassword && canEncrypt()) s.pwd = encrypt(d.pw); }
    if (typeof d.pp === 'string' && d.pp) { mem.set(s.id + ':pp', d.pp); if (canEncrypt()) s.pph = encrypt(d.pp); }
    if (s.askPassword) delete s.pwd;
    if (d.clearPw) { delete s.pwd; delete s.pph; mem.delete(s.id + ':pw'); mem.delete(s.id + ':pp'); }
    write(true);
    send('ftp:changed');
    return publicSrv(s);
  });
  H('ftp:delete', id => {
    const i = servers().findIndex(s => s.id === id);
    if (i >= 0) { drop(id); servers().splice(i, 1); mem.delete(id + ':pw'); mem.delete(id + ':pp'); for (const d of Object.values(data.deploy)) { if (d.server === id) d.server = ''; delete d.maps[id]; } write(true); watchAll(); send('ftp:changed'); }
    return true;
  });
  H('ftp:test', async d => {
    const v = { id: 'test', ...clean(d || {}) };
    const pw = typeof d.pw === 'string' && d.pw ? d.pw : (d.id && srvById(d.id) ? secretOf(srvById(d.id), 'pw') : '');
    const pp = typeof d.pp === 'string' && d.pp ? d.pp : (d.id && srvById(d.id) ? secretOf(srvById(d.id), 'pp') : '');
    const a = v.type === 'sftp' ? await openSftp(v, pw, pp) : await openFtp(v, pw);
    try { const l = await a.list(v.root); return { ok: true, count: l.length }; } finally { a.close(); }
  });
  H('ftp:connect', (id, pw) => conn(id, { password: pw }).then(() => true));
  H('ftp:disconnect', id => { drop(id); return true; });
  H('ftp:ls', (id, dir) => run(id, a => a.list(rnorm(dir))).then(l => l.sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name) : x.dir ? -1 : 1))));
  H('ftp:op', async (id, op, a1, a2) => {
    if (op === 'mkdir') return run(id, a => a.mkdirp(rnorm(a1))).then(() => true);
    if (op === 'rename') return run(id, a => a.rename(rnorm(a1), rnorm(a2))).then(() => true);
    if (op === 'remove') return run(id, a => a.remove(rnorm(a1), !!a2)).then(() => true);
    if (op === 'newfile') return run(id, a => a.putBuffer(Buffer.alloc(0), rnorm(a1))).then(() => true);
    throw new Error('op');
  });
  // remote editing: the text of a remote file, and writing it back
  H('ftp:readText', async (id, p) => {
    const buf = await run(id, a => a.getBuffer(rnorm(p), 3 * 1024 * 1024));
    if (buf.subarray(0, 8000).includes(0)) return { error: __('İkili (binary) dosya, metin olarak açılamaz.') };
    return { text: buf.toString('utf8') };
  });
  H('ftp:writeText', (id, p, text) => run(id, a => a.putBuffer(Buffer.from(String(text), 'utf8'), rnorm(p))).then(() => { send('ftp:log', { kind: 'up', server: id, remote: rnorm(p) }); return true; }));
  H('ftp:getDeploy', root => ({ ...depOf(root), defaults: DEFAULT_EXCLUDES }));
  H('ftp:setDeploy', (root, d) => { if (!insideProject(root)) throw new Error(__('Proje dışında')); return setDep(root, d); });
  H('ftp:upload', async (root, files, sid) => {
    const out = { done: 0, errors: [] };
    for (const f of files || []) {
      let st; try { st = await fsp.stat(f); } catch (_) { out.errors.push(f + ': ' + __('bulunamadı')); continue; }
      if (st.isDirectory()) {
        const list = await walkLocal(root, f, depOf(root).excludes);
        for (const x of list) { try { await uploadFile(root, path.join(root, ...x.rel.split('/')), sid, { quiet: true }); out.done++; } catch (e) { out.errors.push(x.rel + ': ' + e.message); } }
      } else { try { await uploadFile(root, f, sid); out.done++; } catch (e) { out.errors.push(path.basename(f) + ': ' + e.message); } }
    }
    return out;
  });
  H('ftp:download', async (root, files, sid) => {
    const out = { done: 0, errors: [] };
    sid = sid || depOf(root).server;
    for (const f of files || []) {
      const t = resolveLocal(root, f, sid);
      if (!t) { out.errors.push(path.basename(f) + ': ' + __('eşleme yok')); continue; }
      const isDir = await fsp.stat(f).then(s => s.isDirectory(), () => false) || (await run(sid, a => a.stat(t.remote)).catch(() => null) || {}).dir;
      if (isDir) {
        const list = await run(sid, a => walkRemote(a, t.remote, '', depOf(root).excludes, t.rel));
        for (const x of list) { try { await downloadFile(root, sid, x.remote, path.join(root, ...x.rel.split('/'))); out.done++; } catch (e) { out.errors.push(x.rel + ': ' + e.message); } }
      } else { try { await downloadFile(root, sid, t.remote, f); out.done++; } catch (e) { out.errors.push(path.basename(f) + ': ' + e.message); } }
    }
    return out;
  });
  H('ftp:downloadTo', (root, sid, remote, local) => downloadFile(root, sid, rnorm(remote), local || null));
  H('ftp:resolve', (root, file, sid) => { const t = resolveLocal(root, file, sid); return t ? { remote: t.remote, server: t.server.id, rel: t.rel, url: t.server.webUrl ? t.server.webUrl.replace(/\/+$/, '') + '/' + t.remote.slice(rjoin(t.server.root, t.map.remote).length).replace(/^\//, '') : '' } : null; });
  H('ftp:resolveRemote', (root, sid, remote) => resolveRemote(root, sid, remote));
  H('ftp:compare', (root, sid, sub) => compare(root, sid, sub));
  H('ftp:sync', (root, sid, list, jobId) => syncRun(root, sid, list, jobId));
  H('ftp:cancel', jobId => { const j = jobs.get(jobId); if (j) j.cancel = true; return true; });
  // the IDE saved a file: upload it when the project asks for "on save" (or "always")
  H('ftp:saved', async file => {
    for (const d of Object.values(data.deploy)) {
      if (!d.root || !d.server || d.auto === 'off') continue;
      const r = normP(d.root), n = normP(file);
      if (n === r || n.startsWith(r + path.sep)) { await autoOne(d.root, file, false); return true; }
    }
    return false;
  });
  // the remote copy of a project file, for "compare with deployed"
  H('ftp:remoteText', async (root, file, sid) => {
    const t = resolveLocal(root, file, sid);
    if (!t) throw new Error(__('Bu dosya için eşleme yok ya da hariç tutulmuş: {path}', { path: file }));
    const buf = await run(t.server.id, a => a.getBuffer(t.remote, 3 * 1024 * 1024)).catch(e => { if (/550|No such file|not found/i.test(e.message)) return null; throw e; });
    return { remote: t.remote, text: buf == null ? null : buf.toString('utf8') };
  });
  watchAll();

  /* ---------------- for agents (agentlink.js) ---------------- */
  const agentList = () => servers().filter(s => s.aiAccess !== 'deny').map(s => ({ id: s.id, name: s.name || label(s), type: TYPE_NAME[s.type], group: s.group, aiAccess: s.aiAccess || '', label: label(s) }));
  const agentPath = (s, p) => { p = posix(p || ''); return p.startsWith('/') ? rnorm(p) : rjoin(s.root, p); };
  function agentSrv(id) { const s = srvById(id); if (!s || s.aiAccess === 'deny') throw new Error(__('Sunucu bulunamadı.')); return s; }
  const agent = {
    list: agentList,
    root: id => agentSrv(id).root,
    ls: (id, p) => { const s = agentSrv(id); return run(id, a => a.list(agentPath(s, p))); },
    read: async (id, p) => { const s = agentSrv(id); const buf = await run(id, a => a.getBuffer(agentPath(s, p), 2 * 1024 * 1024)); return buf; },
    write: (id, p, text) => { const s = agentSrv(id); const rp = agentPath(s, p); return run(id, async a => { try { await a.putBuffer(Buffer.from(text, 'utf8'), rp); } catch (_) { await a.mkdirp(path.posix.dirname(rp)); await a.putBuffer(Buffer.from(text, 'utf8'), rp); } }).then(() => rp); },
    put: (id, local, p) => { const s = agentSrv(id); const rp = agentPath(s, p); return run(id, async a => { try { await a.put(local, rp); } catch (_) { await a.mkdirp(path.posix.dirname(rp)); await a.put(local, rp); } }).then(() => rp); },
    get: (id, p, local) => { const s = agentSrv(id); return run(id, a => a.get(agentPath(s, p), local)); },
    remove: async (id, p) => { const s = agentSrv(id); const rp = agentPath(s, p); const st = await run(id, a => a.stat(rp)); if (!st) throw new Error(__('Uzak yol bulunamadı: {path}', { path: rp })); await run(id, a => a.remove(rp, st.dir)); return rp; },
    mkdir: (id, p) => { const s = agentSrv(id); const rp = agentPath(s, p); return run(id, a => a.mkdirp(rp)).then(() => rp); },
    rename: (id, a1, a2) => { const s = agentSrv(id); const x = agentPath(s, a1), y = agentPath(s, a2); return run(id, a => a.rename(x, y)).then(() => [x, y]); },
    resolvePath: (id, p) => agentPath(agentSrv(id), p),
    // a project's deployment: which server, and the remote path of each file
    deployOf: root => { const d = data.deploy[normP(root)]; return d && d.server ? d : null; },
    upload: (root, file, sid) => uploadFile(root, file, sid),
    setAiAccess(id, v) { const s = srvById(id); if (!s) return; s.aiAccess = ['allow', 'deny'].includes(v) ? v : ''; write(true); send('ftp:changed'); },
  };

  return {
    agent,
    shutdown() { for (const id of [...pool.keys()]) drop(id); for (const x of watchers.values()) try { x.w.close(); } catch (_) {} write(true); },
  };
};
