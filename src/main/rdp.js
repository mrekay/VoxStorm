// VoxStorm — Remote Desktop on Linux (SSH mode's "Uzak Masaüstü" button).
// FreeRDP (xfreerdp3 / xfreerdp / wlfreerdp) if installed, else Remmina. FreeRDP reads the
// password from its standard input (/from-stdin), so it never appears in the process list.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const I18N = require('../i18n/i18n.js'); const __ = I18N.t;

const onPath = cmd => (process.env.PATH || '').split(':').some(d => d && fs.existsSync(path.join(d, cmd)));

function openLinux(h, password) {
  const port = h.port || 3389;
  const free = ['xfreerdp3', 'xfreerdp', 'wlfreerdp3', 'wlfreerdp'].find(onPath);
  if (free) {
    const args = [`/v:${h.host}:${port}`, '/cert:tofu', '/dynamic-resolution'];
    if (h.user) args.push(`/u:${h.user}`);
    if (h.domain) args.push(`/d:${h.domain}`);
    if (h.fullscreen) args.push('/f');
    if (h.admin) args.push('/admin');
    if (password) args.push('/from-stdin:force');
    try {
      const p = spawn(free, args, { detached: true, stdio: [password ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
      p.on('error', () => {});
      if (password) { p.stdin.on('error', () => {}); p.stdin.end(password + '\n'); }
      p.unref();
    } catch (e) { return { error: e.message }; }
    return { ok: true };
  }
  if (onPath('remmina')) {
    const who = h.user ? encodeURIComponent((h.domain ? h.domain + '\\' : '') + h.user) + '@' : '';
    try { const p = spawn('remmina', ['-c', `rdp://${who}${h.host}:${port}`], { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); }
    catch (e) { return { error: e.message }; }
    return { ok: true };
  }
  return { error: __('Uzak Masaüstü için FreeRDP ya da Remmina gerekli (ör. sudo apt install freerdp3-x11 veya remmina).') };
}

module.exports = { openLinux };
