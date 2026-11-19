// VoxStorm — Docker support, main-process side.
// Works on this computer (the docker CLI) and on an open SSH session (docker run over SSH exec).
// The window never sends a raw command line: it asks for a named operation and the arguments
// are validated and built here. Container shells (docker exec -it) become SSH-mode channels.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/; // container id / name, compose project
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\/:@-]{0,511}$/; // image reference or id
const SHELL_CMD = "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";

module.exports = function registerDocker({ ipcMain, shell, getSsh }) {
  let pty = null;
  const ptyLib = () => pty || (pty = require('@lydell/node-pty'));
  const isLocal = t => !t || t === 'local';
  const shq = a => "'" + String(a).replace(/'/g, "'\\''") + "'";

  /* ---------------- run ---------------- */
  function run(target, args, { timeout = 60000 } = {}) {
    if (isLocal(target)) {
      return new Promise(resolve => {
        execFile('docker', args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, DOCKER_CLI_HINTS: 'false' } }, (err, stdout, stderr) => {
          if (err && err.code === 'ENOENT') { resolve({ code: -1, stdout: '', stderr: 'docker komutu bulunamadı. Docker Desktop kurulu ve PATH içinde olmalı.', missing: true }); return; }
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.killed ? 'Zaman aşımı.' : '')) });
        });
      });
    }
    const ssh = getSsh();
    if (!ssh || !ssh.hasSession(target)) return Promise.resolve({ code: -1, stdout: '', stderr: 'SSH bağlantısı kapalı.' });
    // a login shell finds docker in /usr/local/bin and friends even when PATH is minimal
    return ssh.execOut(target, 'docker ' + args.map(shq).join(' '), { timeout });
  }
  function friendly(r, target) {
    const e = (r.stderr || '').trim();
    if (r.missing) return { error: e, missing: true };
    if (/command not found|docker: not found|No such file/i.test(e) && !isLocal(target)) return { error: 'Sunucuda docker komutu yok.', missing: true };
    if (/permission denied.*docker\.sock/i.test(e)) return { error: 'Docker’a erişim izni yok: kullanıcı “docker” grubunda değil (sudo usermod -aG docker $USER, sonra yeniden bağlan).', denied: true };
    if (/Cannot connect to the Docker daemon|error during connect|pipe.*docker_engine|daemon is not running/i.test(e)) return { error: isLocal(target) ? 'Docker çalışmıyor. Docker Desktop’u başlat.' : 'Sunucuda Docker servisi çalışmıyor.', down: true };
    return { error: e.split('\n').slice(-3).join('\n') || 'docker komutu başarısız oldu (çıkış kodu ' + r.code + ').' };
  }
  const lines = s => s.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const label = (labels, k) => { const m = String(labels || '').match(new RegExp('(?:^|,)' + k.replace(/\./g, '\\.') + '=([^,]*)')); return m ? m[1] : ''; };

  async function listContainers(target) {
    const r = await run(target, ['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
    if (r.code !== 0) return friendly(r, target);
    const items = lines(r.stdout).map(c => ({
      id: String(c.ID || '').slice(0, 12), name: c.Names || '', image: c.Image || '', state: c.State || '', status: c.Status || '',
      ports: c.Ports || '', created: c.CreatedAt || '', running: c.RunningFor || '', health: c.HealthStatus && c.HealthStatus !== 'none' ? c.HealthStatus : (/\((healthy|unhealthy|health: starting)\)/.exec(c.Status || '') || [])[1] || '',
      project: label(c.Labels, 'com.docker.compose.project'), service: label(c.Labels, 'com.docker.compose.service'),
      workdir: label(c.Labels, 'com.docker.compose.project.working_dir'),
      command: c.Command || '',
    }));
    return { items };
  }
  async function listImages(target) {
    const r = await run(target, ['images', '--format', '{{json .}}']);
    if (r.code !== 0) return friendly(r, target);
    return { items: lines(r.stdout).map(i => ({ id: String(i.ID || '').replace(/^sha256:/, '').slice(0, 12), repo: i.Repository, tag: i.Tag, size: i.Size, created: i.CreatedSince || i.CreatedAt, containers: i.Containers })) };
  }
  async function stats(target) {
    const r = await run(target, ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 20000 });
    if (r.code !== 0) return friendly(r, target);
    const out = {};
    for (const s of lines(r.stdout)) out[String(s.ID || s.Container || '').slice(0, 12)] = { cpu: s.CPUPerc, mem: s.MemUsage, memp: s.MemPerc, net: s.NetIO, block: s.BlockIO };
    return { stats: out };
  }

  const CONTAINER_OPS = { start: ['start'], stop: ['stop'], restart: ['restart'], pause: ['pause'], unpause: ['unpause'], kill: ['kill'], rm: ['rm'], rmForce: ['rm', '-f'] };
  const COMPOSE_OPS = { start: ['start'], stop: ['stop'], restart: ['restart'], down: ['down'], pause: ['pause'], unpause: ['unpause'] };

  ipcMain.handle('docker:call', async (_e, target, op, a = {}) => {
    try {
      if (op === 'containers') return await listContainers(target);
      if (op === 'images') return await listImages(target);
      if (op === 'stats') return await stats(target);
      if (op === 'version') {
        const r = await run(target, ['version', '--format', '{{json .}}'], { timeout: 15000 });
        if (r.code !== 0) { let v = null; try { v = JSON.parse(r.stdout); } catch (_) {} return { ...friendly(r, target), client: v && v.Client ? v.Client.Version : '' }; }
        const v = JSON.parse(r.stdout);
        return { client: v.Client && v.Client.Version, server: v.Server && v.Server.Version, os: v.Server && v.Server.Os };
      }
      if (op === 'count') { // the title-bar badge
        const r = await run(target, ['ps', '-q'], { timeout: 10000 });
        if (r.code !== 0) return friendly(r, target);
        return { running: r.stdout.split('\n').filter(Boolean).length };
      }
      if (op === 'container') {
        const args = CONTAINER_OPS[a.action];
        const ids = (Array.isArray(a.ids) ? a.ids : [a.id]).filter(x => NAME_RE.test(String(x || '')));
        if (!args || !ids.length) return { error: 'Geçersiz işlem.' };
        const r = await run(target, [...args, ...ids], { timeout: 120000 });
        return r.code === 0 ? { ok: true } : friendly(r, target);
      }
      if (op === 'compose') {
        const args = COMPOSE_OPS[a.action];
        if (!args || !NAME_RE.test(String(a.project || ''))) return { error: 'Geçersiz işlem.' };
        const r = await run(target, ['compose', '-p', a.project, ...args], { timeout: 300000 });
        return r.code === 0 ? { ok: true } : friendly(r, target);
      }
      if (op === 'rmi') {
        const ids = (Array.isArray(a.ids) ? a.ids : [a.id]).filter(x => IMAGE_RE.test(String(x || '')));
        if (!ids.length) return { error: 'Geçersiz imaj.' };
        const r = await run(target, ['rmi', ...(a.force ? ['-f'] : []), ...ids], { timeout: 120000 });
        return r.code === 0 ? { ok: true } : friendly(r, target);
      }
      if (op === 'pull') {
        if (!IMAGE_RE.test(String(a.image || ''))) return { error: 'Geçersiz imaj adı.' };
        const r = await run(target, ['pull', a.image], { timeout: 900000 });
        return r.code === 0 ? { ok: true } : friendly(r, target);
      }
      if (op === 'prune') {
        const what = { containers: ['container', 'prune', '-f'], images: ['image', 'prune', '-f'], all: ['system', 'prune', '-f'] }[a.what];
        if (!what) return { error: 'Geçersiz işlem.' };
        const r = await run(target, what, { timeout: 300000 });
        return r.code === 0 ? { ok: true, out: r.stdout.trim().split('\n').pop() } : friendly(r, target);
      }
      if (op === 'inspect') {
        if (!NAME_RE.test(String(a.id || ''))) return { error: 'Geçersiz konteyner.' };
        const r = await run(target, ['inspect', a.id]);
        if (r.code !== 0) return friendly(r, target);
        const j = JSON.parse(r.stdout)[0] || {};
        return {
          json: JSON.stringify(j, null, 2),
          env: (j.Config && j.Config.Env) || [],
          mounts: (j.Mounts || []).map(m => ({ type: m.Type, src: m.Source, dst: m.Destination, rw: m.RW })),
          networks: Object.entries((j.NetworkSettings && j.NetworkSettings.Networks) || {}).map(([n, v]) => ({ name: n, ip: v.IPAddress })),
          restart: j.HostConfig && j.HostConfig.RestartPolicy ? j.HostConfig.RestartPolicy.Name : '',
          started: j.State && j.State.StartedAt, exitCode: j.State && j.State.ExitCode,
        };
      }
      if (op === 'startDesktop') { // local only: launch Docker Desktop
        if (process.platform === 'darwin') {
          return await new Promise(res => execFile('open', ['-a', 'Docker'], err => res(err ? { error: 'Docker Desktop bulunamadı (/Applications/Docker.app).' } : { ok: true })));
        }
        const exe = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
        if (!fs.existsSync(exe)) return { error: 'Docker Desktop bulunamadı: ' + exe };
        try { const p = spawn(exe, [], { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); } catch (e) { return { error: e.message }; }
        return { ok: true };
      }
      if (op === 'openUrl') { // a published port, http://localhost:PORT
        const port = parseInt(a.port, 10), host = String(a.host || 'localhost');
        if (!(port > 0 && port < 65536) || !/^[\w.:\[\]-]+$/.test(host)) return { error: 'Geçersiz adres.' };
        await shell.openExternal(`http://${host}:${port}/`);
        return { ok: true };
      }
      return { error: 'Bilinmeyen işlem.' };
    } catch (e) { return { error: e.message }; }
  });

  /* ---------------- logs (follow) ---------------- */
  const logs = new Map(); // streamId -> stop()
  let seq = 0;
  ipcMain.handle('docker:logs', (e, target, id, tail) => {
    if (!NAME_RE.test(String(id || ''))) return { error: 'Geçersiz konteyner.' };
    const n = Math.max(10, Math.min(20000, parseInt(tail, 10) || 500));
    const sid = 'l' + (++seq);
    const wc = e.sender;
    const emit = (ch, ...a) => { if (!wc.isDestroyed()) wc.send(ch, ...a); };
    const args = ['logs', '-f', '--tail', String(n), id];
    let buf = '', timer = null;
    const flush = () => { timer = null; if (buf) { emit('docker:log', sid, buf); buf = ''; } };
    const onData = d => { buf += d; if (buf.length > 65536) flush(); else if (!timer) timer = setTimeout(flush, 80); };
    const onEnd = err => { flush(); logs.delete(sid); emit('docker:logEnd', sid, err || ''); };
    if (isLocal(target)) {
      const p = spawn('docker', args, { windowsHide: true });
      const d1 = new StringDecoder('utf8'), d2 = new StringDecoder('utf8');
      p.stdout.on('data', d => onData(d1.write(d)));
      p.stderr.on('data', d => onData(d2.write(d)));
      p.on('error', err => onEnd(err.code === 'ENOENT' ? 'docker komutu bulunamadı.' : err.message));
      p.on('close', () => onEnd(''));
      logs.set(sid, () => { try { p.kill(); } catch (_) {} });
    } else {
      const ssh = getSsh();
      if (!ssh || !ssh.hasSession(target)) return { error: 'SSH bağlantısı kapalı.' };
      logs.set(sid, ssh.execStream(target, 'docker ' + args.map(shq).join(' '), onData, onEnd));
    }
    wc.once('destroyed', () => { const s = logs.get(sid); if (s) { logs.delete(sid); s(); } });
    return { id: sid };
  });
  ipcMain.handle('docker:logsStop', (_e, sid) => { const s = logs.get(sid); if (s) { logs.delete(sid); s(); } return true; });

  /* ---------------- container shell ---------------- */
  ipcMain.handle('docker:term', async (e, target, id, cols, rows) => {
    if (!NAME_RE.test(String(id || ''))) return { error: 'Geçersiz konteyner.' };
    const ssh = getSsh();
    if (!ssh) return { error: 'SSH modülü yüklenmedi.' };
    if (!isLocal(target)) return ssh.execPty(target, `docker exec -it ${shq(id)} sh -c ${shq(SHELL_CMD)}`, cols, rows);
    let p;
    try {
      p = ptyLib().spawn('docker', ['exec', '-it', id, 'sh', '-c', SHELL_CMD], {
        name: 'xterm-256color', cols: Math.max(20, cols || 100), rows: Math.max(5, rows || 30), cwd: require('os').homedir(), env: process.env,
      });
    } catch (err) { return { error: 'docker exec başlatılamadı: ' + err.message }; }
    const c = ssh.addChannel(e.sender, null, {
      write: d => p.write(d),
      resize: (cc, rr) => p.resize(cc, rr),
      close: () => { try { p.kill(); } catch (_) {} },
    });
    p.onData(d => c.data(d));
    p.onExit(({ exitCode }) => c.exit(exitCode ? 'çıkış kodu ' + exitCode : ''));
    return { ch: c.ch };
  });

  return {
    shutdown() { for (const s of logs.values()) { try { s(); } catch (_) {} } logs.clear(); },
  };
};
