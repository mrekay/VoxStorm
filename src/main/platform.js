// VoxStorm — what differs between Windows and macOS (and other Unix-likes), in one place.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/* A macOS app started from Finder / the Dock gets a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
   so claude, git, gh, node from Homebrew or ~/.local/bin are not found. Ask the user's login
   shell once for its PATH (what Terminal would see) and use it for everything we start. */
function fixUnixEnv() {
  if (IS_WIN) return;
  const shell = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/sh');
  try {
    const mark = '__VOXSTORM_PATH__';
    const out = execFileSync(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' }, // oh-my-zsh: never stall on its update prompt
    });
    const m = out.match(new RegExp(mark + '([^]*?)' + mark));
    if (m && m[1].trim()) process.env.PATH = m[1].trim();
  } catch (_) {}
  // common install places, in case the shell profile did not add them
  const extra = [
    path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'),
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(os.homedir(), '.docker', 'bin'),
  ];
  const parts = (process.env.PATH || '').split(':').filter(Boolean);
  for (const d of extra) if (!parts.includes(d) && fs.existsSync(d)) parts.push(d);
  process.env.PATH = parts.join(':');
  // Finder starts apps without a locale; terminals then mangle Turkish characters
  if (!process.env.LANG) process.env.LANG = 'en_US.UTF-8';
}

/* every match for a command on PATH, like `where` on Windows / `which -a` elsewhere */
function whereAll(name) {
  try {
    const out = IS_WIN
      ? execFileSync('where', [name], { encoding: 'utf8', windowsHide: true })
      : execFileSync('/usr/bin/which', ['-a', name], { encoding: 'utf8' });
    return [...new Set(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  } catch (_) { return []; }
}

/* the user's default shell on macOS / Linux */
const userShell = () => process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : (IS_MAC ? '/bin/zsh' : '/bin/bash');

/* quote one word for a POSIX shell command line */
const shQuote = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

module.exports = { IS_WIN, IS_MAC, fixUnixEnv, whereAll, userShell, shQuote };
