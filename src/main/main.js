// VoxStorm — main process
// Window + tray, terminal processes (node-pty), Claude Code hook listener,
// session history / usage from ~/.claude, project file access for IDE mode.
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell, session, protocol, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const pty = require('@lydell/node-pty');
const { IS_WIN, IS_MAC, fixUnixEnv, whereAll, userShell, shQuote } = require('./platform');
fixUnixEnv(); // macOS: a Finder-started app gets the login shell's PATH (claude, git, gh, brew)
const { appIcon } = require('./icon');
const pluginsModule = require('./plugins');
pluginsModule.registerScheme(protocol); // custom schemes must be registered before 'ready'

// The app used to be called Claudelot: on the first start under the new name, move the old
// settings folder (%APPDATA%\Claudelot) over so projects, settings and usage history stay.
(() => {
  if (app.commandLine.hasSwitch('user-data-dir')) return;
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'Claudelot');
  if (path.resolve(now).toLowerCase() === path.resolve(old).toLowerCase()) return;
  if (fs.existsSync(path.join(now, 'config.json')) || !fs.existsSync(path.join(old, 'config.json'))) return;
  try {
    if (fs.existsSync(now)) fs.rmSync(now, { recursive: true, force: true }); // only what Electron created a moment ago
    fs.renameSync(old, now);
  } catch (_) {
    app.setPath('userData', old); // the old folder is in use: keep using it, try again next time
  }
})();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
// Windows names a notification and decides what a click launches from the Start Menu shortcut
// carrying this ID. A dev run (bare electron.exe) gets its own ID and shortcut so its toasts
// don't show up as "Electron" and a click doesn't open Electron's default app.
const AUMID = app.isPackaged ? 'VoxStorm' : 'VoxStorm.Dev';
app.setAppUserModelId(AUMID);
if (process.platform === 'win32') {
  try { app.setToastActivatorCLSID(app.isPackaged ? '{6E0B6F4A-3C1D-4B7E-9A55-2F1C8D0B7A11}' : '{6E0B6F4A-3C1D-4B7E-9A55-2F1C8D0B7A12}'); } catch (_) {}
}
// notification chimes play from the (often hidden) window without a click first
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DATA = app.getPath('userData');
const CONFIG_FILE = path.join(DATA, 'config.json');
const HOOK_SETTINGS = path.join(DATA, 'hooks-settings.json');
const APPEND_PROMPT = path.join(DATA, 'append-prompt.txt');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

let win = null;
let tray = null;
let isQuitting = false;
let hookPort = 0;
let trayStats = { running: 0, pending: 0 };
const ptys = new Map();
const liveNotifications = new Set();
/* detached modes: a mode (AI, IDE, DB, a plugin's mode) can live in its own window, e.g. on a
   second monitor. Such a window loads the same page locked to that mode (index.html?only=<mode>). */
const modeWins = new Map(); // mode -> its own BrowserWindow
const ptyOwner = new Map(); // pty id -> webContents that shows it (null while it moves to another window)
const ptyBuf = new Map();   // pty id -> recent output, replayed when the terminal moves to another window
const ptyGone = new Map();  // pty id -> exit code of a terminal that ended while moving
const mirrorOwner = new Map(); // mirror id -> webContents
const handoff = new Map();  // webContents id -> terminals waiting to be taken by that window
const trayByWc = new Map(), tabsByWc = new Map(); // per window: tray counts, open terminals (lastTabs)

/* ---------------- config ---------------- */
const DEFAULTS = {
  projects: [],
  removedProjects: [], // paths the user removed; discovery never brings them back
  lastTabs: [], // terminals that were open last time: {projectId, kind, agent, shell, sessionId, title}
  codexNames: {}, // names given in VoxStorm to Codex sessions (Codex's own database is never written)
  settings: {
    uiLang: '', // interface language: 'auto' | 'tr' | 'en' | 'de' | 'es' | 'fr' (src/i18n)
    name: '', tone: 'samimi', // name: filled from git / GitHub on first launch, else no form of address lang: 'tr', extra: '',
    closeToTray: true, autostart: false, sound: true, welcome: true,
    update: { check: true, auto: true }, // look for new releases on GitHub; download and install them
    soundStyle: 'claudelot', // 'claudelot': the app plays its own chime · 'windows': the system notification sound
    // defaults for every Claude session VoxStorm starts ('' = leave it to Claude Code)
    // command: launch command line used instead of plain `claude` ('' = find claude on PATH); chrome: start with --chrome
    claude: { model: '', effort: '', permissionMode: '', remoteControl: false, chrome: false, command: '' },
    // Codex CLI sessions (src/main/codex.js); mode: '' | readonly | never | full
    codex: { model: '', effort: '', mode: '', search: false, command: '' },
    agentLink: true, // Claude / Codex may use the SSH hosts and databases saved in VoxStorm (src/main/agentlink.js), asking first
    defaultAgent: 'claude', // the AI a new session starts with: 'claude' | 'codex'
    notif: { done: true, decision: true, subagent: true, workflow: true, quiet: false },
    skin: 'mono', mode: 'claude', termColors: 'windows',
    customThemes: [], // themes made in the theme editor or by Claude (themes.js): { id, name, dark, colors, image }
    ui: { side: true, queue: true, usage: true }, // IDE panels; AI mode side panels live in ui.dock (dock.js)
  },
  ide: { state: {}, ui: { ex: true, panel: true, size: 13 } },
  windows: {}, // detached mode windows: { [mode]: { bounds, maximized, open } }
};
function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) out[k] = k in base ? merge(base[k], extra[k]) : extra[k];
  return out;
}
let firstRun = !fs.existsSync(CONFIG_FILE);
let config = DEFAULTS;
try { config = merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (_) { config = merge(DEFAULTS, {}); }
/* interface language (src/i18n): settings.uiLang 'auto' follows the system; an install from before
   1.0 (config without uiLang) stays Turkish. Read once: a change applies after a restart. */
const I18N = require('../i18n/i18n.js');
for (const [code] of I18N.LANGS) if (code !== 'tr') I18N.register(code, require(`../i18n/${code}.js`));
if (!config.settings.uiLang) config.settings.uiLang = firstRun ? 'auto' : 'tr';
let systemLangs = [];
try { systemLangs = app.getPreferredSystemLanguages(); } catch (_) {}
I18N.setLang(I18N.resolve(config.settings.uiLang, systemLangs));
const __ = I18N.t;
if (firstRun) config.settings.lang = I18N.lang(); // Claude / Codex answer in the interface language
// every window asks for it synchronously before its first script runs (preload.js)
ipcMain.on('i18n:lang', e => { e.returnValue = I18N.lang(); });
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }, 300);
}
function saveConfigNow() {
  clearTimeout(saveTimer);
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (_) {}
}

/* ---------------- helpers ---------------- */
const alive = w => !!w && !w.isDestroyed();
const allWins = () => [win, ...modeWins.values()].filter(alive);
const ownerWin = mode => (alive(modeWins.get(mode)) ? modeWins.get(mode) : win); // the window showing a mode
const sendTo = (wc, ch, ...args) => { if (wc && !wc.isDestroyed()) wc.send(ch, ...args); };
const send = (ch, ...args) => allWins().forEach(w => w.webContents.send(ch, ...args)); // every app window
const sendMain = (ch, ...args) => { if (alive(win)) win.webContents.send(ch, ...args); };
const encodeProjectDir = p => p.replace(/[^a-zA-Z0-9]/g, '-');
const norm = p => path.resolve(p).toLowerCase();

function insideProject(p) {
  const n = norm(p);
  return config.projects.some(pr => { const r = norm(pr.path); return n === r || n.startsWith(r + path.sep); });
}

const whereFirst = whereAll;
let claudePath = null;
function findClaude() {
  if (claudePath && fs.existsSync(claudePath)) return claudePath;
  const found = whereFirst('claude');
  if (!IS_WIN) {
    const guesses = [path.join(os.homedir(), '.local', 'bin', 'claude'), path.join(os.homedir(), '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
    claudePath = found[0] || guesses.find(g => fs.existsSync(g)) || null;
    return claudePath;
  }
  claudePath = found.find(f => f.toLowerCase().endsWith('.exe')) || found.find(f => f.toLowerCase().endsWith('.cmd')) || null;
  if (!claudePath) {
    const guess = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fs.existsSync(guess)) claudePath = guess;
  }
  return claudePath;
}
// split a command line into words; "double quotes" group words containing spaces
function splitArgs(line) {
  const out = []; const re = /"([^"]*)"|(\S+)/g; let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
const quoteArg = a => (/[\s"&|<>^()]/.test(a) || a === '' ? `"${String(a).replace(/"/g, '""')}"` : a);
/* how to start Claude: the custom launch command from settings, or claude on PATH.
   Returns { file, pre, line } — pre: words placed before VoxStorm's own arguments;
   line: true when it must run through cmd.exe (.cmd/.bat scripts, commands not found as an .exe)
   or, on macOS, through the login shell (a command that is not a file on PATH, e.g. an alias). */
function claudeLaunch() {
  const custom = splitArgs((config.settings.claude || {}).command);
  if (custom.length && !IS_WIN) {
    const [head, ...rest] = custom;
    const exe = path.isAbsolute(head) ? (fs.existsSync(head) ? head : null) : whereFirst(head)[0] || null;
    return exe ? { file: exe, pre: rest, line: false } : { file: head, pre: rest, line: true };
  }
  if (custom.length) {
    const [head, ...rest] = custom;
    let exe = null;
    if (path.isAbsolute(head) && fs.existsSync(head)) exe = head;
    else { const f = whereFirst(head); exe = f.find(x => /\.exe$/i.test(x)) || f.find(x => /\.(cmd|bat)$/i.test(x)) || null; }
    if (exe && /\.exe$/i.test(exe)) return { file: exe, pre: rest, line: false };
    return { file: exe || head, pre: rest, line: true };
  }
  const exe = findClaude();
  if (!exe) return null;
  return { file: exe, pre: [], line: !/\.exe$/i.test(exe) };
}
function findShell(kind) {
  if (!IS_WIN) {
    // zsh / bash as login shells so the user's profile (PATH, prompt, aliases) loads
    if (kind === 'zsh' || kind === 'bash') {
      const f = ['/bin/' + kind, ...whereFirst(kind)].find(c => fs.existsSync(c));
      if (f) return { file: f, args: ['-l'] };
    }
    return { file: userShell(), args: ['-l'] };
  }
  if (kind === 'cmd') return { file: 'cmd.exe', args: [] };
  if (kind === 'bash') {
    const cands = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', ...whereFirst('bash').filter(p => !/system32/i.test(p))];
    const f = cands.find(c => fs.existsSync(c));
    if (!f) throw new Error(__('Git Bash bulunamadı.'));
    return { file: f, args: ['--login', '-i'] };
  }
  const pw = whereFirst('pwsh')[0];
  return { file: pw || 'powershell.exe', args: ['-NoLogo'] };
}

/* ---------------- read head of a file ---------------- */
async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
  return '';
}

async function readTail(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const n = Math.min(bytes, size), buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, size - n);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

/* ---------------- session history ---------------- */
// the transcript of a session: under its project folder first, otherwise any project folder
async function findSessionFile(sessionId, projectPath) {
  if (!/^[\w-]+$/.test(String(sessionId || ''))) return null;
  const name = sessionId + '.jsonl';
  if (projectPath) {
    const f = path.join(PROJECTS_DIR, encodeProjectDir(projectPath), name);
    try { await fsp.access(f); return f; } catch (_) {}
  }
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch (_) { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(PROJECTS_DIR, d.name, name);
    try { await fsp.access(f); return f; } catch (_) {}
  }
  return null;
}
// the same record Claude Code's /rename appends, so the name also shows in its own /resume list
async function renameSession(sessionId, projectPath, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!t) return { ok: false, error: __('Ad boş olamaz.') };
  const file = await findSessionFile(sessionId, projectPath);
  if (!file) return { ok: false, error: __('Oturum dosyası bulunamadı.') };
  let lead = '';
  try { const end = await readTail(file, 1); if (end && end !== '\n') lead = '\n'; } catch (_) {}
  await fsp.appendFile(file, lead + JSON.stringify({ type: 'custom-title', customTitle: t, sessionId }) + '\n', 'utf8');
  titleCache.delete(file);
  return { ok: true, title: t };
}
const titleCache = new Map(); // file -> {mtime, title, cwd}
async function sessionMeta(file, mtimeMs) {
  const c = titleCache.get(file);
  if (c && c.mtime === mtimeMs) return c;
  // name order: custom-title (a rename: Claude Code's /rename or ours), then ai-title (the title
  // Claude Code gives the session, the same one it shows in the terminal title bar), then the first message
  let title = '', cwd = '', custom = '', ai = '';
  const scan = (text, pick) => {
    for (const line of text.split('\n')) {
      if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'custom-title' && typeof o.customTitle === 'string' && (pick.custom || !custom)) custom = o.customTitle;
        else if (o.type === 'ai-title' && o.aiTitle && (pick.ai || !ai)) ai = o.aiTitle;
      } catch (_) {}
    }
  };
  try {
    const head = await readHead(file, 256 * 1024);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!title && o.type === 'user' && !o.isSidechain && !o.isMeta && o.message) {
        const t = textOf(o.message.content).trim();
        if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) title = t;
      }
      if (title && cwd) break;
    }
    // both records are appended as the session goes on: the newest one is near the end
    const st = await fsp.stat(file);
    const tail = st.size > 256 * 1024 ? await readTail(file, 128 * 1024) : head;
    scan(tail, { custom: true, ai: true });
    if (st.size > 256 * 1024 && (!custom || !ai)) scan(head, { custom: !custom, ai: !ai }); // older ones, only if the tail had none
  } catch (_) {}
  const meta = { mtime: mtimeMs, title: (custom || ai || title || __('Adsız oturum')).replace(/\s+/g, ' ').slice(0, 120), cwd };
  titleCache.set(file, meta);
  return meta;
}
async function listSessions(projectPath) {
  const dir = path.join(PROJECTS_DIR, encodeProjectDir(projectPath));
  let files;
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.jsonl')); } catch (_) { return []; }
  const stats = await Promise.all(files.map(async f => {
    const full = path.join(dir, f);
    try { const st = await fsp.stat(full); return { full, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size }; } catch (_) { return null; }
  }));
  const list = stats.filter(s => s && s.size > 0).sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  const out = [];
  for (const s of list) {
    const m = await sessionMeta(s.full, s.mtime);
    out.push({ id: s.id, title: m.title, mtime: s.mtime });
  }
  return out;
}
/* ~/.claude/projects/<name>: the name is the folder path with every non-alphanumeric
   character turned into '-'. Walk the disk to find the folder that encodes to it. */
async function decodeProjectDir(enc) {
  // Windows: C:\\Users\\x -> "C--Users-x" · macOS: /Users/x -> "-Users-x"
  const m = IS_WIN ? enc.match(/^([A-Za-z])--(.+)$/) : enc.match(/^-(.+)$/);
  if (!m) return null;
  async function walk(dir, rest, depth) {
    if (depth > 24) return null;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return null; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const k = encodeProjectDir(e.name);
      if (rest === k) return path.join(dir, e.name);
      if (rest.startsWith(k + '-')) { const r = await walk(path.join(dir, e.name), rest.slice(k.length + 1), depth + 1); if (r) return r; }
    }
    return null;
  }
  return IS_WIN ? walk(m[1].toUpperCase() + ':' + path.sep, m[2], 0) : walk('/', m[1], 0);
}
/* add every folder with Claude Code history that is not in the list yet (unless the user removed it) */
async function syncDiscovered() {
  const removed = new Set((config.removedProjects || []).map(norm));
  const known = new Set(config.projects.map(x => norm(x.path)));
  const found = (await discoverProjects()).filter(f => !removed.has(norm(f.path)) && !known.has(norm(f.path)));
  found.forEach(f => addProject(f.path, true));
  if (found.length) { saveConfigNow(); send('projects-changed', config.projects); }
  return found.length;
}
async function discoverProjects() {
  let dirs;
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch (_) { return []; }
  const found = [];
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d);
    let files;
    try { files = (await fsp.readdir(full)).filter(f => f.endsWith('.jsonl')); } catch (_) { continue; }
    let newest = null;
    for (const f of files) {
      try { const st = await fsp.stat(path.join(full, f)); if (!newest || st.mtimeMs > newest.mtime) newest = { f, mtime: st.mtimeMs }; } catch (_) {}
    }
    if (newest) {
      const meta = await sessionMeta(path.join(full, newest.f), newest.mtime);
      if (meta.cwd && fs.existsSync(meta.cwd) && encodeProjectDir(meta.cwd) === d) { found.push({ path: meta.cwd, mtime: newest.mtime }); continue; }
    }
    // no session file (or it names another folder): rebuild the path from the folder name
    const back = await decodeProjectDir(d);
    if (back) { let mtime = 0; try { mtime = (await fsp.stat(full)).mtimeMs; } catch (_) {} found.push({ path: back, mtime: newest ? newest.mtime : mtime }); }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/* ---------------- live sessions ----------------
   Claude Code keeps ~/.claude/sessions/<pid>.json for every running session, with
   its session id, folder and status (busy / idle / waiting). Sessions opened in an
   outside terminal show up here, so VoxStorm can follow them instead of starting
   a second copy with --resume. */
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const ownPid = new Map(); // claude pid -> started by one of our terminals?
function classifyPids(pids) {
  // a terminal may run claude through cmd.exe, so check the parent process as well
  const todo = pids.filter(p => !ownPid.has(p));
  if (!todo.length) return;
  const roots = new Set([...ptys.values()].map(p => p.pid));
  const parents = {};
  if (!IS_WIN) {
    try {
      const out = execFileSync('/bin/ps', ['-o', 'pid=,ppid=', '-p', todo.join(',')], { encoding: 'utf8', timeout: 8000 });
      for (const line of out.split(/\r?\n/)) { const [a, b] = line.trim().split(/\s+/).map(Number); if (a) parents[a] = b; }
    } catch (_) {}
  } else try {
    const filter = todo.map(p => 'ProcessId=' + p).join(' or ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    for (const line of out.split(/\r?\n/)) { const [a, b] = line.trim().split(/\s+/).map(Number); if (a) parents[a] = b; }
  } catch (_) {}
  for (const p of todo) ownPid.set(p, roots.has(p) || roots.has(parents[p]));
}
let liveList = [], liveSig = '', liveBusy = false;
async function scanLive() {
  if (liveBusy) return liveList;
  liveBusy = true;
  try {
    let files = [];
    try { files = (await fsp.readdir(SESSIONS_DIR)).filter(f => /^\d+\.json$/.test(f)); } catch (_) {}
    const raw = [];
    for (const f of files) {
      let o; try { o = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8')); } catch (_) { continue; }
      if (!o || !o.pid || !SID_RE.test(o.sessionId || '') || (o.kind && o.kind !== 'interactive')) continue;
      if (!pidAlive(o.pid)) continue;
      raw.push(o);
    }
    classifyPids(raw.map(o => o.pid));
    const list = [];
    for (const o of raw) {
      if (ownPid.get(o.pid)) continue;
      const file = path.join(PROJECTS_DIR, encodeProjectDir(o.cwd || ''), o.sessionId + '.jsonl');
      let title = o.name || __('Oturum');
      try { const st = await fsp.stat(file); title = (await sessionMeta(file, st.mtimeMs)).title; } catch (_) {}
      list.push({
        pid: o.pid, sessionId: o.sessionId, cwd: o.cwd || '', title,
        status: o.status || 'idle', waitingFor: o.waitingFor || '',
        startedAt: o.startedAt || 0, updatedAt: o.statusUpdatedAt || o.updatedAt || 0,
      });
    }
    list.sort((a, b) => b.startedAt - a.startedAt);
    for (const p of [...ownPid.keys()]) if (!raw.some(o => o.pid === p)) ownPid.delete(p);
    liveList = list;
    const sig = JSON.stringify(list);
    if (sig !== liveSig) { liveSig = sig; send('live-sessions', list); }
    return list;
  } finally { liveBusy = false; }
}
function watchLive() {
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(() => scanLive().catch(() => {}), 250); };
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); fs.watch(SESSIONS_DIR, kick); } catch (_) {}
  setInterval(kick, 4000); // also catches sessions whose process died without cleaning up
  kick();
}
function transcriptOf(sessionId) {
  const s = liveList.find(x => x.sessionId === sessionId);
  if (s) return path.join(PROJECTS_DIR, encodeProjectDir(s.cwd), sessionId + '.jsonl');
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  } catch (_) {}
  return null;
}
function liveEntries(o, sidechain) {
  // turn one transcript line into what the watch view shows; most lines are bookkeeping
  if (o.isSidechain && !sidechain) return [];
  if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command' && typeof o.attachment.prompt === 'string') {
    return [{ k: 'user', text: o.attachment.prompt, ts: o.timestamp }];
  }
  if (!o.message) return [];
  const c = o.message.content;
  if (o.type === 'user' && !o.isMeta) {
    if (typeof c === 'string') return c.trim() && !c.startsWith('<') ? [{ k: 'user', text: c, ts: o.timestamp }] : [];
    if (Array.isArray(c)) {
      const text = c.filter(b => b.type === 'text' && !String(b.text).startsWith('<')).map(b => b.text).join('\n').trim();
      const imgs = c.filter(b => b.type === 'image').length;
      if (text || imgs) return [{ k: 'user', text: text + (imgs ? (text ? '\n' : '') + __('[{n} görsel]', { n: imgs }) : ''), ts: o.timestamp }];
    }
    return [];
  }
  if (o.type === 'assistant' && Array.isArray(c)) {
    const out = [];
    for (const b of c) {
      if (b.type === 'text' && b.text.trim()) out.push({ k: 'ai', text: b.text, ts: o.timestamp });
      else if (b.type === 'tool_use') {
        const i = b.input || {};
        const what = i.description || i.command || i.file_path || i.pattern || i.url || i.query || i.prompt || '';
        out.push({ k: 'tool', name: b.name, text: String(what).replace(/\s+/g, ' ').slice(0, 300), ts: o.timestamp });
      }
    }
    return out;
  }
  return [];
}
const TAIL_FIRST = 3 * 1024 * 1024; // first read of a long transcript starts this far from the end
/* A subagent's own conversation: <project>/<session>/subagents/agent-<id>.jsonl, next to
   agent-<id>.meta.json which records the Agent tool call (toolUseId) that started it. */
const AGENT_ID_RE = /^[\w-]{1,64}$/;
function subagentDir(sessionId) {
  const f = transcriptOf(sessionId);
  return f ? path.join(f.slice(0, -'.jsonl'.length), 'subagents') : null;
}
function agentMeta(dir, agentId) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8')); } catch (_) { return null; }
}
function findSubagent(sessionId, { agentId, toolUseId } = {}) {
  const dir = subagentDir(sessionId); if (!dir) return null;
  if (agentId && AGENT_ID_RE.test(agentId)) return { agentId, file: path.join(dir, `agent-${agentId}.jsonl`) };
  if (!toolUseId) return null;
  let names = []; try { names = fs.readdirSync(dir); } catch (_) { return null; }
  for (const n of names) {
    const m = /^agent-([\w-]+)\.meta\.json$/.exec(n); if (!m) continue;
    const meta = agentMeta(dir, m[1]);
    if (meta && meta.toolUseId === toolUseId) return { agentId: m[1], file: path.join(dir, `agent-${m[1]}.jsonl`) };
  }
  return null;
}
// SubagentStop says which agent stopped; add the Agent tool call that started it so the
// renderer can match it to the row it opened on PreToolUse
function enrichSubagentStop(ev) {
  let id = ev.agent_id;
  if (!id && ev.agent_transcript_path) { const m = /agent-([\w-]+)\.jsonl$/.exec(ev.agent_transcript_path); if (m) id = m[1]; }
  if (!id || !AGENT_ID_RE.test(id)) return;
  ev.agent_id = id;
  const dir = ev.agent_transcript_path ? path.dirname(ev.agent_transcript_path) : SID_RE.test(ev.session_id || '') && subagentDir(ev.session_id);
  const meta = dir && agentMeta(dir, id);
  if (meta && meta.toolUseId) ev.vs_tool_use_id = meta.toolUseId;
}
/* A Workflow call returns at once (status async_launched, runId); when the run ends Claude
   Code writes its snapshot to <project>/<session>/workflows/<runId>.json. */
const RUN_ID_RE = /^wf_[\w-]{1,64}$/;
function workflowState(sessionId, runId) {
  if (!SID_RE.test(sessionId || '') || !RUN_ID_RE.test(runId || '')) return null;
  const f = transcriptOf(sessionId); if (!f) return null;
  let snap;
  try { snap = JSON.parse(fs.readFileSync(path.join(f.slice(0, -'.jsonl'.length), 'workflows', runId + '.json'), 'utf8')); } catch (_) { return { done: false }; }
  const st = String(snap.status || '');
  if (/^(running|pending|starting|queued)$/i.test(st)) return { done: false };
  return { done: true, status: st, error: snap.error ? String(snap.error).slice(0, 300) : '' };
}
/* Everything the workflow window shows, read from what Claude Code writes while a run goes on:
   <session>/workflows/scripts/<name>-<runId>.js (meta: name, description, phases),
   <session>/subagents/workflows/<runId>/journal.jsonl (agent started / result),
   agent-<id>.meta.json (model, phase) and agent-<id>.jsonl (tokens, time, what it is doing now),
   <session>/workflows/<runId>.json (the snapshot when the run has ended).
   Without a runId (a run that has not answered yet) the newest run of the session is shown. */
const wfAgentCache = new Map(); // transcript file -> { size, first, last, out, ctx, now }
function wfAgentStats(file) {
  let st; try { st = fs.statSync(file); } catch (_) { return null; }
  let c = wfAgentCache.get(file);
  if (!c || st.size < c.size) c = { size: 0, first: 0, last: 0, out: 0, ctx: 0, now: '', rest: '' };
  if (st.size > c.size) {
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - c.size);
      fs.readSync(fd, buf, 0, buf.length, c.size); fs.closeSync(fd);
      text = c.rest + buf.toString('utf8');
    } catch (_) { return c; }
    const lines = text.split('\n');
    c.rest = lines.pop(); // a line still being written
    for (const line of lines) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      const ts = Date.parse(o.timestamp) || 0;
      if (ts) { if (!c.first) c.first = ts; c.last = ts; }
      if (o.type !== 'assistant' || !o.message) continue;
      const u = o.message.usage;
      if (u) { c.out += u.output_tokens || 0; c.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); }
      for (const b of Array.isArray(o.message.content) ? o.message.content : []) {
        if (b.type === 'tool_use') {
          const i = b.input || {};
          const what = i.description || i.command || i.file_path || i.pattern || i.url || i.query || '';
          c.now = `${b.name}${what ? ': ' + String(what).replace(/\s+/g, ' ').slice(0, 160) : ''}`;
        } else if (b.type === 'text' && b.text.trim()) c.now = b.text.replace(/\s+/g, ' ').trim().slice(0, 160);
      }
    }
    c.size = st.size;
    wfAgentCache.set(file, c);
  }
  return c;
}
function wfScriptMeta(dir, runId) {
  let src = '';
  try {
    const f = fs.readdirSync(dir).find(n => n.endsWith('-' + runId + '.js') || n === runId + '.js');
    if (f) src = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 200000);
  } catch (_) {}
  const str = re => { const m = re.exec(src); return m ? m[2] : ''; };
  const meta = { name: str(/\bname\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/), description: str(/\bdescription\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/), phases: [] };
  const ph = /\bphases\s*:\s*\[([\s\S]*?)\]/.exec(src);
  if (ph) { const re = /\btitle\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g; let m; while ((m = re.exec(ph[1]))) meta.phases.push(m[2]); }
  return meta;
}
function workflowDetail(sessionId, runId) {
  if (!SID_RE.test(sessionId || '') || (runId && !RUN_ID_RE.test(runId))) return null;
  const f = transcriptOf(sessionId); if (!f) return null;
  const base = f.slice(0, -'.jsonl'.length);
  const runsDir = path.join(base, 'subagents', 'workflows');
  if (!runId) {
    try {
      runId = fs.readdirSync(runsDir).filter(n => RUN_ID_RE.test(n))
        .map(n => ({ n, t: fs.statSync(path.join(runsDir, n)).ctimeMs })).sort((a, b) => b.t - a.t).map(x => x.n)[0];
    } catch (_) {}
    if (!runId) return { missing: true };
  }
  const dir = path.join(runsDir, runId);
  const meta = wfScriptMeta(path.join(base, 'workflows', 'scripts'), runId);
  const agents = new Map(); let started = 0;
  try {
    started = fs.statSync(path.join(dir, 'journal.jsonl')).birthtimeMs || 0;
    for (const line of fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e.agentId || !AGENT_ID_RE.test(e.agentId)) continue;
      const a = agents.get(e.agentId) || { id: e.agentId, label: e.label || '', phase: e.phase || '', state: 'running' };
      if (e.label) a.label = e.label;
      if (e.phase) a.phase = e.phase;
      if (e.type === 'result') {
        a.state = 'done';
        const r = e.result;
        a.result = (typeof r === 'string' ? r : r && typeof r === 'object' ? (r.summary || r.result || JSON.stringify(r, null, 1)) : String(r == null ? '' : r)).slice(0, 4000);
        if (r && Array.isArray(r.commits)) a.commits = r.commits.slice(0, 20).map(String);
      } else if (/error|fail|cancel|abort/i.test(e.type)) { a.state = 'failed'; a.result = String(e.error || e.message || e.type).slice(0, 2000); }
      agents.set(e.agentId, a);
    }
  } catch (_) {}
  const list = [...agents.values()].map(a => {
    const m = agentMeta(dir, a.id) || {};
    const s = wfAgentStats(path.join(dir, `agent-${a.id}.jsonl`)) || {};
    return { ...a, phase: a.phase || m.workflowPhase || '', model: m.model || '', tokens: (s.ctx || 0) + (s.out || 0), first: s.first || 0, last: s.last || 0, now: a.state === 'running' ? s.now || '' : '' };
  });
  for (const a of list) if (a.first && (!started || a.first < started)) started = a.first;
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(path.join(base, 'workflows', runId + '.json'), 'utf8')); } catch (_) {}
  const status = snap ? String(snap.status || '') : 'running';
  const running = !snap || /^(running|pending|starting|queued)$/i.test(status);
  return {
    runId, name: meta.name || runId, description: meta.description, phases: meta.phases, agents: list,
    started, ended: running ? 0 : Math.max(0, ...list.map(a => a.last)), running, status,
    error: snap && snap.error ? String(snap.error).slice(0, 1000) : '',
  };
}
async function tailTranscript(sessionId, offset, agent) {
  if (!SID_RE.test(sessionId || '')) return null;
  let file, agentId = null;
  if (agent) {
    const a = findSubagent(sessionId, agent);
    if (a) { file = a.file; agentId = a.agentId; }
    if (!file || !fs.existsSync(file)) return { offset: 0, entries: [], missing: true, agentId };
  } else file = transcriptOf(sessionId);
  if (!file) return { offset: 0, entries: [], missing: true };
  let st; try { st = await fsp.stat(file); } catch (_) { return { offset: 0, entries: [], missing: true }; }
  let from = offset || 0, trimmed = false;
  if (from > st.size) from = 0;
  if (!offset && st.size > TAIL_FIRST) { from = st.size - TAIL_FIRST; trimmed = true; }
  if (from === st.size) return { offset: from, entries: [] };
  const fh = await fsp.open(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(st.size - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    buf = buf.slice(0, bytesRead);
  } finally { await fh.close(); }
  // only consume complete lines; a half-written last line is read again next time
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { offset: from, entries: [] };
  const lines = buf.slice(0, end).toString('utf8').split('\n');
  if (trimmed) lines.shift(); // started mid-line
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    entries.push(...liveEntries(o, !!agent));
  }
  if (offset && !agent) for (const e of entries) if (e.k === 'user') learnAddress(e.text);
  return { offset: from + end + 1, entries, trimmed, agentId };
}
async function takeOver(sessionId) {
  // close the outside copy so the conversation can continue in a VoxStorm terminal
  const s = liveList.find(x => x.sessionId === sessionId);
  if (!s) return { ok: true };
  try { process.kill(s.pid); } catch (e) { return { ok: false, error: __('Dışarıdaki oturum kapatılamadı: {error}', { error: e.message }) }; }
  for (let i = 0; i < 50 && pidAlive(s.pid); i++) await new Promise(r => setTimeout(r, 100));
  if (pidAlive(s.pid)) return { ok: false, error: __('Dışarıdaki oturum kapanmadı.') };
  await scanLive().catch(() => {});
  return { ok: true, cwd: s.cwd };
}

/* ---------------- console mirror for outside sessions ----------------
   mirror.cs attaches to the console of an outside Claude session, streams its screen
   and types keys into it. It is compiled once with the csc.exe that ships with Windows
   and cached in the data folder (keyed by a hash of the source). */
const mirrors = new Map(); // id -> child process
let mirrorBuild = null;
function mirrorBinary() {
  if (mirrorBuild) return mirrorBuild;
  mirrorBuild = (async () => {
    const src = fs.readFileSync(path.join(__dirname, 'mirror.cs'), 'utf8');
    const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
    const exe = path.join(DATA, `mirror-${hash}.exe`);
    if (fs.existsSync(exe)) return exe;
    const win = process.env.WINDIR || 'C:\\Windows';
    const csc = ['Framework64', 'Framework'].map(f => path.join(win, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(f => fs.existsSync(f));
    if (!csc) throw new Error(__('Terminal bağlantısı için gereken .NET derleyicisi (csc.exe) bulunamadı.'));
    fs.mkdirSync(DATA, { recursive: true });
    const cs = path.join(DATA, `mirror-${hash}.cs`);
    fs.writeFileSync(cs, src);
    await new Promise((resolve, reject) => execFile(csc, ['-nologo', '-target:winexe', '-optimize', '-out:' + exe, cs],
      { windowsHide: true, timeout: 60000 }, (err, out) => (err ? reject(new Error(__('Terminal bağlantı aracı derlenemedi. {error}', { error: String(out || err.message).trim() }))) : resolve())));
    try { fs.unlinkSync(cs); } catch (_) {}
    return exe;
  })();
  mirrorBuild.catch(() => { mirrorBuild = null; });
  return mirrorBuild;
}
async function startMirror(sessionId, owner) {
  const s = liveList.find(x => x.sessionId === sessionId);
  if (!s) throw new Error(__('Oturum artık açık değil.'));
  // attaching to another terminal's console is a Windows API; macOS shows the conversation only
  if (!IS_WIN) throw new Error(__('Bu sistemde dışarıdaki terminale bağlanılamıyor; konuşma görünür, devralarak burada devam edebilirsin.'));
  const exe = await mirrorBinary();
  const id = crypto.randomUUID();
  const child = spawn(exe, [String(s.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  mirrors.set(id, child);
  mirrorOwner.set(id, owner || null);
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const p = line.split(' ');
      if (p[0] === 'F') sendTo(mirrorOwner.get(id), 'mirror:frame', id, { cols: +p[1], rows: +p[2], cx: +p[3], cy: +p[4], vis: p[5] === '1', off: +p[6], max: +p[7], vt: Buffer.from(p[8] || '', 'base64').toString('utf8') });
      else if (p[0] === 'E') sendTo(mirrorOwner.get(id), 'mirror:error', id, __('Terminale bağlanılamadı (Windows hata kodu {code}).', { code: p[1] }));
    }
  });
  child.stdin.on('error', () => {});
  child.on('exit', () => { mirrors.delete(id); sendTo(mirrorOwner.get(id), 'mirror:exit', id); mirrorOwner.delete(id); });
  child.on('error', e => { mirrors.delete(id); sendTo(mirrorOwner.get(id), 'mirror:error', id, e.message); mirrorOwner.delete(id); });
  return { id, pid: s.pid };
}
/* xterm sends VT text; the console wants key events: [virtual key, char, control state] */
const CTRL = { SHIFT: 0x10, ALT: 0x02, CTRLK: 0x08 };
const SEQ_KEYS = { A: 38, B: 40, C: 39, D: 37, H: 36, F: 35 };
const TILDE_KEYS = { 2: 45, 3: 46, 5: 33, 6: 34 };
function keysOf(data) {
  const out = [];
  const modState = m => { m = (+m || 1) - 1; return (m & 1 ? CTRL.SHIFT : 0) | (m & 2 ? CTRL.ALT : 0) | (m & 4 ? CTRL.CTRLK : 0); };
  for (let i = 0; i < data.length;) {
    const rest = data.slice(i);
    let m;
    if ((m = rest.match(/^\x1b\[(?:1;(\d))?([ABCDHF])/)) || (m = rest.match(/^\x1bO()([ABCDHF])/))) { out.push([SEQ_KEYS[m[2]], 0, modState(m[1])]); i += m[0].length; continue; }
    if ((m = rest.match(/^\x1b\[(\d)(?:;(\d))?~/)) && TILDE_KEYS[m[1]]) { out.push([TILDE_KEYS[m[1]], 0, modState(m[2])]); i += m[0].length; continue; }
    if (rest.startsWith('\x1b[Z')) { out.push([9, 9, CTRL.SHIFT]); i += 3; continue; }
    const ch = data.charCodeAt(i);
    if (ch === 0x1b && i + 1 < data.length && data[i + 1] !== '\x1b' && data[i + 1] !== '[' && data[i + 1] !== 'O') {
      const c2 = data.charCodeAt(i + 1);
      out.push([c2 >= 97 && c2 <= 122 ? c2 - 32 : 0, c2, CTRL.ALT]); i += 2; continue; // Alt+key
    }
    if (ch === 13) out.push([13, 13, 0]);
    else if (ch === 0x7f || ch === 8) out.push([8, 8, 0]);
    else if (ch === 9) out.push([9, 9, 0]);
    else if (ch === 0x1b) out.push([27, 27, 0]);
    else if (ch === 10) out.push([13, 10, CTRL.CTRLK]);
    else if (ch > 0 && ch < 27) out.push([64 + ch, ch, CTRL.CTRLK]); // Ctrl+letter
    else out.push([ch >= 48 && ch <= 57 ? ch : ch >= 97 && ch <= 122 ? ch - 32 : ch >= 65 && ch <= 90 ? ch : 0, ch, ch >= 65 && ch <= 90 ? CTRL.SHIFT : 0]);
    i++;
  }
  return out;
}
function mirrorInput(id, data) {
  const child = mirrors.get(id);
  if (!child || typeof data !== 'string' || !data) return;
  const keys = keysOf(data.slice(0, 100000));
  for (let i = 0; i < keys.length; i += 400) child.stdin.write('I ' + keys.slice(i, i + 400).map(k => k.join(' ')).join(' ') + '\n');
}
function stopMirror(id) { const c = mirrors.get(id); if (c) { try { c.kill(); } catch (_) {} mirrors.delete(id); } mirrorOwner.delete(id); }

/* ---------------- weekly usage (tokens from transcripts) ---------------- */
/* API list prices, $ per million tokens (Anthropic first-party, Nov 2026).
   read = cache read price; cache writes cost 1.25x input (5 min) or 2x input (1 hour).
   A subscription plan is not billed this way — this is the API-equivalent value. */
const PRICES = [
  ['claude-fable-5-2', 8, 40, 0.20], ['claude-mythos-5-2', 8, 40, 0.20],
  ['claude-fable-5-1', 10, 50], ['claude-mythos-5-1', 10, 50], ['claude-fable-5', 10, 50], ['claude-mythos-5', 10, 50],
  ['claude-opus-5-5', 4, 20, 0.20], ['claude-opus-5', 5, 25], ['claude-opus-4-8', 5, 25], ['claude-opus-4-7', 5, 25], ['claude-opus-4-6', 5, 25],
  ['claude-sonnet-5-5', 2, 10, 0.10], ['claude-sonnet-5', 2, 10], ['claude-sonnet-4-6', 3, 15],
  ['claude-haiku-5-5', 0.10, 0.50], ['claude-haiku-4-5', 1, 5],
];
function priceOf(model) {
  if (!model) return null;
  // longest matching id wins, so "claude-opus-5-5" is not priced as "claude-opus-5"
  let best = null;
  for (const p of PRICES) if (model.startsWith(p[0]) && (!best || p[0].length > best[0].length)) best = p;
  if (!best) return null;
  const [, input, out, read] = best;
  return { input, out, read: read != null ? read : input * 0.1 };
}
function messageCost(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
  const fast = u.speed === 'fast' ? 2 : 1;
  return fast * ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.out + w5m * p.input * 1.25 + w1h * p.input * 2 + (u.cache_read_input_tokens || 0) * p.read) / 1e6;
}

let usageCache = null, usageRun = null;
function computeUsage() {
  // share one in-flight scan between callers instead of returning a stale/empty result
  if (!usageRun) usageRun = scanUsage().finally(() => { usageRun = null; });
  return usageRun;
}
/* Usage = every assistant message in ~/.claude/projects, deduplicated by message id.
   Claude Code deletes transcripts after ~30 days, so daily totals are also kept in
   usage-history.json; days that no longer have transcripts come from there. */
const USAGE_HISTORY = path.join(DATA, 'usage-history.json');
const fileCache = new Map(); // transcript path -> { mtime, size, entries: [{id, ts, model, proj, t, o, c}] }
let usageHistory = null;     // 'YYYY-MM-DD' -> { t, c, rows: { 'proj|model': [tokens, output, usd] } }
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function listTranscripts() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch (_) {}
  for (const d of dirs) {
    const walk = async (p, depth) => {
      let ents; try { ents = await fsp.readdir(p, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const fp = path.join(p, e.name);
        if (e.isDirectory() && depth < 3) await walk(fp, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ fp, proj: d });
      }
    };
    await walk(path.join(PROJECTS_DIR, d), 0);
  }
  return out;
}
async function parseTranscript(fp, proj) {
  const entries = [];
  let text; try { text = await fsp.readFile(fp, 'utf8'); } catch (_) { return entries; }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    const m = o.message; if (!m || !m.usage || !o.timestamp) continue;
    const ts = Date.parse(o.timestamp); if (!ts) continue;
    const u = m.usage;
    entries.push({
      id: m.id || o.uuid, ts, model: m.model || '?', proj,
      t: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0),
      o: u.output_tokens || 0, c: messageCost(m.model, u),
    });
  }
  return entries;
}
async function scanUsage() {
  if (!usageHistory) { try { usageHistory = JSON.parse(await fsp.readFile(USAGE_HISTORY, 'utf8')); } catch (_) { usageHistory = {}; } }
  const files = await listTranscripts();
  // Codex sessions count too (rollout files in ~/.codex/sessions)
  for (const fp of await CODEX.rollouts().catch(() => [])) files.push({ fp, codex: true });
  const seen = new Set();
  for (const { fp, proj, codex } of files) {
    seen.add(fp);
    let st; try { st = await fsp.stat(fp); } catch (_) { continue; }
    const c = fileCache.get(fp);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) continue;
    fileCache.set(fp, { mtime: st.mtimeMs, size: st.size, entries: codex ? await CODEX.parseRollout(fp) : await parseTranscript(fp, proj) });
  }
  for (const k of [...fileCache.keys()]) if (!seen.has(k)) fileCache.delete(k);

  // last line per message id wins (streaming writes the same message more than once)
  // Claude and Codex are counted apart (the usage view shows one of them); only Claude's days go to
  // usage-history.json (Claude Code deletes old transcripts, Codex keeps its rollouts)
  const msgs = new Map(), cx = new Map();
  let cxLimits = null;
  for (const f of fileCache.values()) {
    for (const e of f.entries) (e.id.startsWith('codex:') ? cx : msgs).set(e.id, e);
    if (f.entries.limits && (!cxLimits || f.entries.limits.at > cxLimits.at)) cxLimits = f.entries.limits;
  }
  const fresh = {};
  for (const e of msgs.values()) {
    const k = dayKey(e.ts);
    const day = fresh[k] || (fresh[k] = { t: 0, c: 0, rows: {} });
    const rk = e.proj + '|' + e.model;
    const row = day.rows[rk] || (day.rows[rk] = [0, 0, 0]);
    row[0] += e.t; row[1] += e.o; row[2] += e.c || 0;
    day.t += e.t; day.c += e.c || 0;
  }
  // merge: keep whichever is larger, so a day partly cleaned up by Claude Code never shrinks
  for (const [k, day] of Object.entries(fresh)) {
    if (!usageHistory[k] || day.t >= usageHistory[k].t) usageHistory[k] = day;
  }
  try { await fsp.writeFile(USAGE_HISTORY, JSON.stringify(usageHistory)); } catch (_) {}

  const now = new Date();
  const monday = new Date(now); monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const days = [0, 0, 0, 0, 0, 0, 0], dayCost = [0, 0, 0, 0, 0, 0, 0];
  const weekKeys = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    weekKeys.push(dayKey(d.getTime()));
    const rec = usageHistory[weekKeys[i]];
    if (rec) { days[i] = rec.t; dayCost[i] = rec.c; }
  }
  const keys = Object.keys(usageHistory).sort();
  // rolling 5-hour window (Claude's session limits are counted over 5 hours)
  const since = Date.now() - 5 * 3600e3;
  const last5h = { t: 0, c: 0 };
  for (const e of msgs.values()) if (e.ts >= since) { last5h.t += e.t; last5h.c += e.c || 0; }
  usageCache = {
    last5h,
    days, dayCost, total: days.reduce((a, b) => a + b, 0), cost: dayCost.reduce((a, b) => a + b, 0),
    today: (now.getDay() + 6) % 7, weekStart: monday.getTime(), at: Date.now(),
    firstDay: keys[0] || null,
  };
  // Codex: the same week straight from its rollouts (no money: a ChatGPT plan is not billed per token)
  const cxDays = [0, 0, 0, 0, 0, 0, 0], cx5h = { t: 0, c: null };
  for (const e of cx.values()) {
    const i = weekKeys.indexOf(dayKey(e.ts));
    if (i >= 0) cxDays[i] += e.t;
    if (e.ts >= since) cx5h.t += e.t;
  }
  usageCache.codex = {
    last5h: cx5h, days: cxDays, dayCost: null, total: cxDays.reduce((a, b) => a + b, 0), cost: null,
    today: usageCache.today, weekStart: usageCache.weekStart, at: usageCache.at,
    installed: CODEX.installed(), plan: CODEX.planRows(cxLimits),
  };
  return usageCache;
}
ipcMain.handle('usage:history', async () => { await computeUsage(); return usageHistory; });
/* Plan limits, as Claude Code's /usage shows them ("Current week (all models) 44% used").
   Read with the login Claude Code keeps in ~/.claude/.credentials.json; the token never leaves
   this process and is never refreshed or written here — when it has expired, Claude Code renews it
   the next time it runs. Cached for a minute. */
let planCache = null;
ipcMain.handle('usage:plan', async (_e, force) => {
  if (!force && planCache && Date.now() - planCache.at < 60000) return planCache;
  let oauth;
  try { oauth = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth; } catch (_) { oauth = null; }
  // on macOS Claude Code keeps the login in the Keychain instead of a file
  if (!oauth && IS_MAC) {
    try {
      const raw = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 15000 });
      oauth = JSON.parse(raw.trim()).claudeAiOauth;
    } catch (_) { oauth = null; }
  }
  if (!oauth || !oauth.accessToken) return (planCache = { at: Date.now(), error: 'nologin' });
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) return (planCache = { at: Date.now(), error: 'expired' });
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage?skip_spend=1', {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'VoxStorm' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || r.status === 403) return (planCache = { at: Date.now(), error: 'expired' });
    if (!r.ok) return (planCache = { at: Date.now(), error: 'http', status: r.status });
    const d = await r.json();
    const rows = [];
    const win = (title, l) => { if (l && l.utilization != null) rows.push({ title, percent: l.utilization, resetsAt: l.resets_at || null, severity: 'normal' }); };
    win(__('Bu oturum (5 saat)'), d.five_hour);
    if (Array.isArray(d.limits) && d.limits.length) {
      for (const l of d.limits) {
        if (l.percent == null) continue;
        const model = l.scope && l.scope.model && l.scope.model.display_name;
        const title = l.kind === 'weekly_all' ? __('Bu hafta (tüm modeller)') : model ? __('Bu hafta ({model})', { model }) : (l.kind ? String(l.kind).replace(/_/g, ' ') : __('Limit'));
        rows.push({ title, percent: l.percent, resetsAt: l.resets_at || null, severity: l.severity || 'normal' });
      }
    } else {
      // older answer shape: the fixed windows Claude Code itself falls back to
      win(__('Bu hafta (tüm modeller)'), d.seven_day);
      win(__('Bu hafta (yalnızca Sonnet)'), d.seven_day_sonnet);
      win(__('Bu hafta ({model})', { model: 'Opus' }), d.seven_day_opus);
      for (const m of d.model_scoped || []) win(__('Bu hafta ({model})', { model: m.display_name }), m);
    }
    return (planCache = { at: Date.now(), rows, plan: oauth.subscriptionType || null });
  } catch (err) {
    return (planCache = { at: Date.now(), error: 'net', message: String(err && err.message || err) });
  }
});
ipcMain.handle('usage:exportCsv', async (e, month) => {
  await computeUsage();
  const names = Object.fromEntries(config.projects.map(p => [encodeProjectDir(p.path), p.name]));
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) || win, {
    title: __('Kullanımı CSV olarak kaydet'),
    defaultPath: path.join(app.getPath('documents'), `claude-kullanim-${month || 'tum'}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const lines = ['tarih;proje;model;token;cikti_token;usd'];
  for (const k of Object.keys(usageHistory).sort()) {
    if (month && !k.startsWith(month)) continue;
    for (const [rk, [t, o, c]] of Object.entries(usageHistory[k].rows || {})) {
      const [proj, model] = rk.split('|');
      lines.push([k, names[proj] || proj, model, t, o, c.toFixed(4).replace('.', ',')].join(';'));
    }
  }
  await fsp.writeFile(r.filePath, '﻿' + lines.join('\r\n'), 'utf8'); // BOM so Excel reads Turkish characters
  return r.filePath;
});

/* ---------------- hooks ---------------- */
function writeHookSettings() {
  const url = `http://127.0.0.1:${hookPort}/hook`;
  const command = `${IS_WIN ? 'curl.exe' : 'curl'} -s -m 3 -X POST -H "Content-Type: application/json" --data-binary @- ${url}`;
  const h = [{ type: 'command', command, timeout: 5 }];
  const settings = {
    hooks: {
      SessionStart: [{ hooks: h }],
      SessionEnd: [{ hooks: h }],
      UserPromptSubmit: [{ hooks: h }],
      Stop: [{ hooks: h }],
      SubagentStop: [{ hooks: h }],
      Notification: [{ hooks: h }],
      PreToolUse: [{ matcher: '*', hooks: h }],
      PostToolUse: [{ matcher: '*', hooks: h }],
    },
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(HOOK_SETTINGS, JSON.stringify(settings, null, 2));
}
function startHookServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') { res.end(''); return; }
      const chunks = []; let size = 0;
      req.on('data', c => { chunks.push(c); size += c.length; if (size > 5e6) req.destroy(); });
      req.on('end', () => {
        res.end('');
        let ev; try { ev = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return; }
        if (!ev || typeof ev !== 'object') return;
        // Codex hooks: /hook?agent=codex&pty=<terminal id> (the terminal is known before the session id)
        try { const q = new URL(req.url, 'http://x').searchParams; if (q.get('agent') === 'codex') { ev.vs_agent = 'codex'; ev.vs_pty = q.get('pty') || ''; } } catch (_) {}
        if (ev.hook_event_name === 'UserPromptSubmit' && ev.prompt) learnAddress(ev.prompt);
        if (ev.hook_event_name === 'SubagentStop' && !ev.vs_agent) { try { enrichSubagentStop(ev); } catch (_) {} }
        send('hook', ev);
      });
    });
    server.listen(0, '127.0.0.1', () => { hookPort = server.address().port; writeHookSettings(); resolve(); });
  });
}

/* ---------------- who the user is (git / GitHub) ----------------
   Read once on first launch so VoxStorm can address the user by name; kept in
   config.identity as the starting point for the git / GitHub features. */
function runQuiet(cmd, args, timeout = 4000) {
  return new Promise(res => {
    try { execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout }, (err, out) => res(err ? '' : String(out).trim())); } catch (_) { res(''); }
  });
}
async function gitIdentity() {
  const [name, email] = await Promise.all([runQuiet('git', ['config', '--global', 'user.name']), runQuiet('git', ['config', '--global', 'user.email'])]);
  return { name, email };
}
async function githubIdentity() {
  if (!whereFirst('gh').length) return {};
  const out = await runQuiet('gh', ['api', 'user', '--jq', '[.login, (.name // "")] | @tsv'], 8000);
  const [login, name] = out.split('\t');
  return login ? { login, name: (name || '').trim() } : {};
}
const firstNameOf = n => String(n || '').trim().split(/\s+/)[0] || '';
async function detectIdentity({ firstLaunch }) {
  const g = await gitIdentity();
  const id = { name: g.name, email: g.email, github: '', source: g.name ? 'git' : '', at: Date.now() };
  // git is local and fast: on first launch, use it before the welcome screen opens
  if (firstLaunch && !config.settings.name && id.name) setAddress(firstNameOf(id.name), false);
  config.identity = id;
  saveConfig();
  // GitHub needs the network; fill in when it answers
  githubIdentity().then(h => {
    if (!h.login) return;
    id.github = h.login;
    if (!id.name && h.name) { id.name = h.name; id.source = 'github'; if (firstLaunch && !config.settings.name) setAddress(firstNameOf(h.name), true); }
    config.identity = id;
    saveConfig();
  }).catch(() => {});
}
function setAddress(name, notify) {
  config.settings.name = name;
  saveConfig();
  writeAppendPrompt();
  if (notify) send('config-changed', config);
}

/* "bana Ertuğrul diye hitap et" / "call me Ed" in a prompt updates the form of address */
const NOT_A_NAME = /^(şöyle|böyle|öyle|nasıl|ne|bu|şu|o|bir|başka|farklı|this|that|what)$/i;
function addressFromPrompt(text) {
  const s = String(text || '').slice(0, 2000);
  if (/bana\s+(?:artık\s+|bundan\s+sonra\s+)?(?:hiç\s+)?hitap\s+etme/i.test(s)) return '';
  const pats = [
    /bana\s+(?:bundan\s+sonra\s+|artık\s+)?["“'‘]?([^\n"”'’.,!?]{1,30}?)["”'’]?\s+(?:diye|olarak)\s+(?:hitap\s+et|seslen|çağır|de(?=[\s.,!?]|$)|söyle)/i,
    /bana\s+["“'‘]?([^\s"”'’.,!?]{2,20})["”'’]?\s+de\s*(?:[.!]|$)/i,
    /\bcall\s+me\s+["“']?([^\n"”'.,!?]{1,30}?)["”']?(?=[\s.,!?]|$)/i,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (!m) continue;
    const name = m[1].trim().split(/\s+/).slice(0, 3).join(' ');
    if (name && !NOT_A_NAME.test(name)) return name.charAt(0).toLocaleUpperCase('tr') + name.slice(1);
  }
  return null;
}
function learnAddress(text) {
  const name = addressFromPrompt(text);
  if (name === null || name === (config.settings.name || '')) return;
  setAddress(name, true);
  const aiWin = ownerWin('claude');
  if (alive(aiWin)) sendTo(aiWin.webContents, 'address-learned', name);
}

/* ---------------- "how to address me" prompt ---------------- */
// functions, not tables: the text follows the interface language, chosen after this file loads
const TONES = () => ({
  samimi: __('Samimi, rahat bir dille konuş.'),
  resmi: __('Resmi ve saygılı bir dille konuş.'),
  kisa: __('Kısa ve öz cevap ver, gereksiz açıklama yapma.'),
});
const LANGS = () => ({ tr: __('Türkçe'), en: __('İngilizce'), de: __('Almanca'), es: __('İspanyolca'), fr: __('Fransızca') });
function buildAppendPrompt() {
  const s = config.settings;
  const tones = TONES(), langs = LANGS();
  const lines = [__('Kullanıcı tercihleri (VoxStorm):')];
  if ((s.name || '').trim()) lines.push('- ' + __('Kullanıcıya "{name}" diye hitap et.', { name: s.name.trim() }));
  if (tones[s.tone]) lines.push('- ' + tones[s.tone]);
  if (langs[s.lang]) lines.push('- ' + __('Yanıtlarını {lang} ver.', { lang: langs[s.lang] }));
  (s.extra || '').split('\n').map(x => x.trim()).filter(Boolean).forEach(x => lines.push('- ' + x));
  return lines.join('\n');
}
function writeAppendPrompt() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(APPEND_PROMPT, buildAppendPrompt());
}

/* ---------------- terminals ---------------- */
function spawnTerminal(opts, owner) {
  const id = crypto.randomUUID();
  let file, args = [], sessionId = null;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  if (opts.kind === 'claude' && opts.agent === 'codex') {
    writeAppendPrompt();
    const l = CODEX.launch({ resume: opts.resume, overrides: opts.overrides, extra: AGENT ? AGENT.codexArgs(id) : [] }, id);
    ptyMeta.set(id, { agent: 'Codex', cwd });
    file = l.file; args = l.args; sessionId = opts.resume || null; // a new session's id comes with its first hook
  } else if (opts.kind === 'claude') {
    const launch = claudeLaunch();
    if (!launch) throw new Error(__('claude komutu bulunamadı. Claude Code kurulu ve PATH içinde olmalı ya da Ayarlar → Claude oturumları → Açılış komutu doldurulmalı.'));
    args.push(...launch.pre);
    if (opts.resume) { args.push('--resume', opts.resume); sessionId = opts.resume; }
    else { sessionId = crypto.randomUUID(); args.push('--session-id', sessionId); }
    args.push('--settings', HOOK_SETTINGS);
    if (AGENT) args.push(...AGENT.claudeArgs(id));
    ptyMeta.set(id, { agent: 'Claude', cwd });
    const cs = { ...(config.settings.claude || {}), ...(opts.overrides || {}) };
    if (cs.model) args.push('--model', cs.model);
    if (cs.effort) args.push('--effort', cs.effort);
    if (cs.permissionMode) args.push('--permission-mode', cs.permissionMode);
    if (cs.remoteControl) args.push('--remote-control', opts.rcName || 'VoxStorm');
    if (cs.chrome && !args.includes('--chrome')) args.push('--chrome');
    writeAppendPrompt();
    args.push('--append-system-prompt-file', APPEND_PROMPT);
    if (launch.line && !IS_WIN) { file = userShell(); args = ['-lc', 'exec ' + [launch.file, ...args].map(shQuote).join(' ')]; }
    else if (launch.line) { file = 'cmd.exe'; args = '/d /s /c "' + [quoteArg(launch.file), ...args.map(quoteArg)].join(' ') + '"'; }
    else file = launch.file;
  } else {
    const sh = findShell(opts.shell);
    file = sh.file; args = sh.args;
  }
  // drop per-session markers in case VoxStorm itself was started from inside a Claude Code session
  const env = { ...process.env, CLAUDELOT: '1', FORCE_COLOR: '1' };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || /^CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|SSE_PORT|SESSION_ID)/.test(k) || /^CODEX_(THREAD_ID|SANDBOX|MANAGED_)/.test(k)) delete env[k];
  const p = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(20, opts.cols || 120),
    rows: Math.max(5, opts.rows || 30),
    cwd,
    env,
  });
  ptyOwner.set(id, owner || null);
  ptyBuf.set(id, '');
  p.onData(d => {
    let b = (ptyBuf.get(id) || '') + d;
    if (b.length > PTY_BUF * 1.25) { b = b.slice(-PTY_BUF); const nl = b.indexOf('\n'); if (nl >= 0 && nl < 4096) b = b.slice(nl + 1); }
    ptyBuf.set(id, b);
    sendTo(ptyOwner.get(id), 'pty:data', id, d);
  });
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (ptyMeta.delete(id) && AGENT) AGENT.release(id);
    const wc = ptyOwner.get(id);
    if (wc === null) { ptyGone.set(id, exitCode); return; } // moving between windows: the new one is told when it takes it
    sendTo(wc, 'pty:exit', id, exitCode);
    dropPty(id);
  });
  ptys.set(id, p);
  return { id, sessionId };
}
/* ---------------- updates (GitHub Releases) ---------------- */
let U = null;
let SSH = null;
let DB = null;
let AGENT = null;
const ptyMeta = new Map(); // pty id -> { agent: 'Claude' | 'Codex', cwd } for the AI sessions
// SSH hosts and databases for Claude / Codex, through VoxStorm (the agent never sees addresses or passwords)
const agentNotes = new Set();
function setupAgentLink() {
  AGENT = require('./agentlink')({
    DATA, version: app.getVersion(),
    getSsh: () => SSH, getDb: () => DB,
    enabled: () => config.settings.agentLink !== false,
    sessionInfo: id => {
      const m = ptyMeta.get(id) || { agent: __('Ajan'), cwd: '' };
      const pr = m.cwd && config.projects.find(x => norm(x.path) === norm(m.cwd));
      const wc = ptyOwner.get(id);
      return { agent: m.agent, cwd: m.cwd, project: (pr && pr.name) || (m.cwd ? path.basename(m.cwd) : '?'), win: (wc && !wc.isDestroyed() && BrowserWindow.fromWebContents(wc)) || ownerWin('claude') };
    },
    // the window that shows a mode ('ide', 'db', 'claude'…; anything else: the main window)
    winFor: mode => ownerWin(mode),
    getDocker: () => DOCKER,
    getThemes: () => THEMES,
    // an agent's notify_user: a click brings its session's tab forward
    notifyTab: (title, body, ptyId) => {
      try {
        const n = new Notification({ title, body, icon: appIcon(64, 1) });
        n.on('click', () => {
          const wc = ptyOwner.get(ptyId), w = (wc && !wc.isDestroyed() && BrowserWindow.fromWebContents(wc)) || win;
          if (!alive(w)) return;
          if (!w.isVisible()) w.show();
          if (w.isMinimized()) w.restore();
          w.focus();
          sendTo(w.webContents, 'focus-tab', ptyId);
        });
        agentNotes.add(n); // kept alive so the click still arrives
        n.on('close', () => agentNotes.delete(n));
        setTimeout(() => agentNotes.delete(n), 10 * 60 * 1000);
        n.show();
      } catch (_) {}
    },
    notify: (title, body) => { try { new Notification({ title, body, icon: appIcon(64, 1) }).show(); } catch (_) {} },
    onAccessChanged: kind => send('agent-access', kind),
  });
  return AGENT.start();
}
let DOCKER = null;
let THEMES = null; // custom theme background images (themes.js)
// Codex CLI sessions (OpenAI), shown and handled like Claude's
const CODEX = require('./codex')({ config: () => config, hookPort: () => hookPort, buildPrompt: () => buildAppendPrompt(), encodeProjectDir });
function setupUpdater() {
  const { net } = require('electron');
  U = require('./updater')({
    app, net, DATA,
    settings: () => Object.assign({ check: true, auto: true }, config.settings.update || {}),
    notify: (title, body) => { try { new Notification({ title, body, icon: appIcon(64, 1), silent: true }).show(); } catch (_) {} },
    onState: st => send('update:state', st),
    beforeRestart: () => { isQuitting = true; killAll(); saveConfigNow(); app.quit(); },
  });
  ipcMain.handle('update:state', () => U.state());
  ipcMain.handle('update:check', () => U.check({ quiet: true }));
  ipcMain.handle('update:download', () => U.download());
  ipcMain.handle('update:restart', () => U.restart());
}
const PTY_BUF = 256 * 1024;
function dropPty(id) { ptyOwner.delete(id); ptyBuf.delete(id); ptyGone.delete(id); }
function killPty(id) { const p = ptys.get(id); if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); } dropPty(id); }
function killAll() {
  for (const id of [...mirrors.keys()]) stopMirror(id);
  for (const p of ptys.values()) { try { p.kill(); } catch (_) {} }
  ptys.clear();
  ptyOwner.clear(); ptyBuf.clear(); ptyGone.clear(); handoff.clear();
}
// a window reloads or goes away: end the terminals and console mirrors it showed
function killOwned(wc, wcId, waiting) {
  for (const [id, o] of [...ptyOwner]) if (o === wc) killPty(id);
  for (const [id, o] of [...mirrorOwner]) if (o === wc) stopMirror(id);
  if (waiting) { for (const t of handoff.get(wcId) || []) if (t.id) killPty(t.id); handoff.delete(wcId); }
}

/* ---------------- window / tray ---------------- */
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
async function quitFlow() {
  const n = ptys.size;
  if (n > 0) {
    if (win && !win.isVisible()) showWindow();
    const opts = {
      title: __('Çıkılsın mı?'), message: __('{n} terminal hâlâ açık.', { n }), ok: __('Çık'), danger: true, icon: 'fa-power-off',
      detail: __('Terminaller kapanır. Claude oturumları geçmişte kalır, sonra kaldığın yerden devam edebilirsin.'),
    };
    let yes;
    // only the app's own themed dialog, never a system message box; a page that cannot answer lets the quit go on
    try { yes = await win.webContents.executeJavaScript(`window.uiConfirm(${JSON.stringify(opts)})`, true); }
    catch (_) { yes = true; }
    if (!yes) return;
  }
  isQuitting = true;
  killAll();
  saveConfigNow();
  app.quit();
}
/* ---------------- welcome window ---------------- */
let welcome = null;
let pendingOpen = null; // what the welcome window asked the main window to do
function showWelcome() {
  if (welcome && !welcome.isDestroyed()) { welcome.show(); welcome.focus(); return; }
  welcome = new BrowserWindow({
    width: 880, height: 580, resizable: false, maximizable: false, minimizable: true,
    frame: false, backgroundColor: '#0b0a12', show: false, title: 'VoxStorm', center: true,
    icon: appIcon(64, 1),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  welcome.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'));
  welcome.once('ready-to-show', () => welcome.show());
  welcome.webContents.on('will-navigate', e => e.preventDefault());
  welcome.on('closed', () => { welcome = null; rebuildTrayMenu(); });
}
function closeWelcome() { if (welcome && !welcome.isDestroyed()) welcome.close(); }
async function welcomeData() {
  const projects = await Promise.all(config.projects.map(async p => {
    const list = fs.existsSync(p.path) ? await listSessions(p.path) : [];
    const restore = (config.lastTabs || []).filter(t => t.projectId === p.id).length;
    return { ...p, last: list[0] ? list[0].mtime : 0, used: Math.max(list[0] ? list[0].mtime : 0, p.added || 0), lastTitle: list[0] ? list[0].title : '', count: list.length, restore, missing: !fs.existsSync(p.path) };
  }));
  projects.sort((a, b) => (!!b.fav - !!a.fav) || b.used - a.used); // favourites first
  const ids = new Set(config.projects.map(p => p.id));
  const restoreAll = (config.lastTabs || []).filter(t => ids.has(t.projectId)).length;
  return { projects, restoreAll, name: config.settings.name || '', skin: config.settings.skin, customThemes: config.settings.customThemes || [], usage: usageCache ? usageCache.total : null, cost: usageCache ? usageCache.cost : null, open: ptys.size };
}

function rebuildTrayMenu() {
  if (!tray) return;
  const { running, pending } = trayStats;
  const counts = __('{running} çalışıyor · {pending} karar bekliyor', { running, pending });
  tray.setToolTip('VoxStorm · ' + counts);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win && win.isVisible() ? __('Pencereyi gizle') : __('Pencereyi göster'), click: () => (win.isVisible() ? win.hide() : showWindow()) },
    { label: __('Karşılama ekranı'), click: () => showWelcome() },
    { label: __('Ayarlar'), click: () => { showWindow(); sendMain('open-settings'); } },
    { label: __('Rahatsız etme'), type: 'checkbox', checked: !!config.settings.notif.quiet, click: m => { config.settings.notif.quiet = m.checked; saveConfig(); send('config-changed', config); } },
    { type: 'separator' },
    { label: counts, enabled: false },
    { type: 'separator' },
    { label: __('Çık'), click: () => quitFlow() },
  ]));
}
function createTray() {
  // the macOS menu bar wants a small (~18pt) icon; @2x keeps it sharp on Retina
  tray = new Tray(IS_MAC ? appIcon(18, 2) : appIcon(32, 2));
  // macOS opens the menu on click (the menu bar convention); Windows toggles the window
  if (!IS_MAC) tray.on('click', () => { if (win.isVisible() && win.isFocused()) win.hide(); else showWindow(); rebuildTrayMenu(); });
  rebuildTrayMenu();
}
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 620,
    // macOS: keep the native traffic lights inside the app's own title bar (40px high)
    ...(IS_MAC ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 } } : { frame: false }),
    backgroundColor: '#0b0a12', show: false, title: 'VoxStorm',
    icon: appIcon(64, 1),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (process.argv.includes('--hidden')) return;
    if (config.settings.welcome !== false) showWelcome(); else win.show();
  });
  win.on('close', e => {
    if (isQuitting) return;
    e.preventDefault();
    if (config.settings.closeToTray) { win.hide(); rebuildTrayMenu(); }
    else quitFlow();
  });
  win.on('show', rebuildTrayMenu);
  win.on('hide', rebuildTrayMenu);
  win.once('show', reopenModeWindows); // detached modes come back with the main window
  pageEvents(win);
}
/* what every app window (main or detached) does the same way */
function pageEvents(w) {
  const wc = w.webContents, wcId = wc.id;
  w.on('maximize', () => sendTo(wc, 'win:state', { maximized: true }));
  w.on('unmaximize', () => sendTo(wc, 'win:state', { maximized: false }));
  w.on('enter-full-screen', () => sendTo(wc, 'win:state', { fullscreen: true })); // macOS green button
  w.on('leave-full-screen', () => sendTo(wc, 'win:state', { fullscreen: false }));
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', e => e.preventDefault());
  // if the UI reloads it loses its terminals, so don't leave orphan processes behind. Only for the page
  // itself: 'did-start-loading' also fires for every iframe (plugin panels), which killed all terminals.
  wc.on('did-start-navigation', (e, url, inPlace, isMain) => {
    const mainFrame = typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMain;
    const sameDoc = typeof e.isSameDocument === 'boolean' ? e.isSameDocument : inPlace;
    if (mainFrame && !sameDoc) killOwned(wc, wcId, false);
  });
}

/* ---------------- detached mode windows ----------------
   A mode moves to its own window (e.g. DB on a second monitor) and comes back when that window
   closes. Terminals live with AI mode: detaching AI moves the main window's terminals along
   (the processes keep running; the new window replays their recent output), and a detached
   window that closes hands its terminals to whichever window shows AI mode. */
const MODE_RE = /^[a-z][\w.:-]{0,139}$/i;
const MODE_TITLES = { claude: 'AI', ide: 'IDE', db: 'DB', ssh: 'SSH' };
const modeTitle = m => `VoxStorm · ${MODE_TITLES[m] || (String(m).startsWith('plugin:') ? __('Eklenti') : m)}`;
function focusWin(w) {
  if (!alive(w)) return;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
}
function broadcastDetached() { send('win:detached', [...modeWins.keys()]); }
function winPrefs(mode, patch) {
  const all = config.windows || (config.windows = {});
  all[mode] = Object.assign({}, all[mode], patch);
  saveConfig();
}
function rememberBounds(mode, w) {
  if (!alive(w)) return;
  winPrefs(mode, { bounds: w.isMaximized() || w.isMinimized() ? w.getNormalBounds() : w.getBounds(), maximized: w.isMaximized() });
}
// saved bounds only if they still land on a connected screen
function visibleBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const { screen } = require('electron');
  const a = screen.getDisplayMatching(b).workArea;
  const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
  const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
  return w >= 120 && h >= 80 ? { x: b.x, y: b.y, width: Math.max(720, b.width), height: Math.max(480, b.height) } : null;
}
function openModeWindow(mode, focus) {
  const saved = (config.windows || {})[mode] || {};
  const w = new BrowserWindow({
    ...(visibleBounds(saved.bounds) || { width: 1280, height: 820 }), minWidth: 720, minHeight: 480,
    // macOS: the traffic lights, like the main window (the page hides its own window buttons there)
    ...(IS_MAC ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 } } : { frame: false }),
    backgroundColor: '#0b0a12', show: false, title: modeTitle(mode),
    icon: appIcon(64, 1),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = w.webContents, wcId = wc.id;
  w._vsMode = mode; w._vsTitle = modeTitle(mode);
  modeWins.set(mode, w);
  winPrefs(mode, { open: true });
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { only: mode } });
  w.once('ready-to-show', () => {
    if (saved.maximized) w.maximize();
    if (focus) w.show(); else w.showInactive();
  });
  pageEvents(w);
  // a page with unsaved files asked to stay; once the user agreed to close, let it go
  wc.on('will-prevent-unload', e => { if (w._vsReleased && !isQuitting) e.preventDefault(); });
  w.on('close', e => {
    rememberBounds(mode, w);
    if (isQuitting || w._vsReleased) return;
    e.preventDefault();
    if (!w._vsClosing) releaseModeWindow(mode, w);
  });
  w.on('closed', () => {
    if (modeWins.get(mode) === w) modeWins.delete(mode);
    killOwned(wc, wcId, true);
    if (isQuitting) return; // keep lastTabs and the "open" flag: the window comes back next time
    trayByWc.delete(wcId); sumTray();
    tabsByWc.delete(wcId);
    broadcastDetached();
  });
  broadcastDetached();
  return w;
}
// closing a detached window: ask about unsaved files, hand its terminals over, show the mode in the main window
async function releaseModeWindow(mode, w) {
  w._vsClosing = true;
  let ok = true;
  try { ok = await w.webContents.executeJavaScript('window.vsCanClose ? window.vsCanClose() : true', true); } catch (_) {}
  if (!ok) { w._vsClosing = false; return; }
  if (modeWins.get(mode) === w) modeWins.delete(mode);
  winPrefs(mode, { open: false });
  broadcastDetached();
  await moveTabs(w.webContents, ownerWin('claude'));
  w._vsReleased = true;
  if (alive(w)) w.close();
  if (alive(win)) { showWindow(); sendMain('win:set-mode', mode); }
}
async function detachMode(mode) {
  if (!MODE_RE.test(String(mode || ''))) return false;
  if (alive(modeWins.get(mode))) { focusWin(modeWins.get(mode)); return true; }
  const w = openModeWindow(mode, true);
  if (mode === 'claude' && alive(win)) await moveTabs(win.webContents, w);
  return true;
}
function attachMode(mode) {
  const w = modeWins.get(mode);
  if (alive(w)) w.close(); // the 'close' handler brings the mode back
  else if (alive(win)) { showWindow(); sendMain('win:set-mode', mode); }
}
function reopenModeWindows() {
  for (const [mode, st] of Object.entries(config.windows || {})) {
    if (st && st.open && MODE_RE.test(mode) && !modeWins.has(mode)) openModeWindow(mode, false);
  }
}
/* move the terminals of one window to another: the source lets go of them (its xterms close,
   the processes keep running), the target takes them with their recent output */
async function moveTabs(fromWc, toWin) {
  let list = [];
  try { list = await fromWc.executeJavaScript('window.vsReleaseTabs ? window.vsReleaseTabs() : []', true); } catch (_) {}
  if (!Array.isArray(list)) return;
  list = list.filter(t => t && typeof t === 'object' && (t.kind === 'watch' ? SID_RE.test(String(t.sessionId || '')) : ptys.has(t.id)));
  if (!list.length) return;
  if (!alive(toWin)) { list.forEach(t => t.id && killPty(t.id)); return; }
  for (const t of list) if (t.id) ptyOwner.set(t.id, null);
  const key = toWin.webContents.id;
  handoff.set(key, [...(handoff.get(key) || []), ...list]);
  sendTo(toWin.webContents, 'win:tabs'); // a window that is still loading takes them when it starts
}
function sumTray() {
  let running = 0, pending = 0;
  for (const s of trayByWc.values()) { running += +s.running || 0; pending += +s.pending || 0; }
  trayStats = { running, pending };
  rebuildTrayMenu();
}
function appMenu() {
  if (IS_MAC) {
    // macOS needs the app menu and real Edit accelerators: Cmd+C / Cmd+V / Cmd+A in text fields and
    // terminals only work through them. Ctrl stays with the terminal (Ctrl+C stops, Ctrl+R searches).
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'VoxStorm', submenu: [
        { role: 'about', label: __('VoxStorm hakkında') }, { type: 'separator' },
        { label: __('Ayarlar…'), accelerator: 'Cmd+,', click: () => { showWindow(); send('open-settings'); } },
        { type: 'separator' }, { role: 'hide', label: __('VoxStorm\'u gizle') }, { role: 'hideOthers', label: __('Diğerlerini gizle') }, { role: 'unhide', label: __('Tümünü göster') },
        { type: 'separator' }, { label: __('VoxStorm\'dan çık'), accelerator: 'Cmd+Q', click: () => quitFlow() },
      ] },
      { label: __('Düzen'), submenu: [{ role: 'undo', label: __('Geri al') }, { role: 'redo', label: __('Yinele') }, { type: 'separator' }, { role: 'cut', label: __('Kes') }, { role: 'copy', label: __('Kopyala') }, { role: 'paste', label: __('Yapıştır') }, { role: 'selectAll', label: __('Tümünü seç') }] },
      { label: __('Görünüm'), submenu: [{ role: 'toggleDevTools', accelerator: 'Cmd+Alt+I' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen', label: __('Tam ekran') }] },
      { label: __('Pencere'), submenu: [{ role: 'minimize', label: __('Küçült') }, { role: 'zoom', label: __('Yakınlaştır') }, { label: __('Kapat'), accelerator: 'Cmd+W', click: () => win && win.close() }, { type: 'separator' }, { role: 'front', label: __('Tümünü öne getir') }] },
    ]));
    return;
  }
  // keeps copy/paste shortcuts working, removes reload shortcuts that would wipe terminals
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    // registerAccelerator:false lets Chromium handle Ctrl+C/V itself (no double paste into terminals)
    { label: __('Düzen'), submenu: ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].map(role => ({ role, registerAccelerator: false })) },
    { label: __('Görünüm'), submenu: [{ role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  // a new interface language: start again (open Claude sessions come back like after any restart)
  ipcMain.handle('app:relaunch', () => { isQuitting = true; killAll(); saveConfigNow(); app.relaunch(); app.exit(0); });
  ipcMain.handle('config:get', () => ({ config, info: { uiLang: I18N.lang(), platform: process.platform, claude: findClaude(), codex: CODEX.installed(), hookPort, hookSettings: HOOK_SETTINGS, appendPrompt: APPEND_PROMPT, home: os.homedir() } }));
  ipcMain.handle('config:set', (e, patch) => {
    // every window reports its own open terminals; lastTabs is all of them together
    if (patch && Array.isArray(patch.lastTabs)) { tabsByWc.set(e.sender.id, patch.lastTabs); patch = { ...patch, lastTabs: [].concat(...tabsByWc.values()) }; }
    config = merge(config, patch);
    for (const w of allWins()) if (w.webContents !== e.sender) w.webContents.send('config-changed', config);
    if (patch.settings && 'autostart' in patch.settings) {
      try { app.setLoginItemSettings({ openAtLogin: !!config.settings.autostart, args: ['--hidden'] }); } catch (_) {}
    }
    saveConfig();
    rebuildTrayMenu();
    return config;
  });
  ipcMain.handle('config:setIdeState', (_e, state) => { config.ide.state = state; saveConfig(); });
  ipcMain.handle('prompt:preview', () => buildAppendPrompt());

  ipcMain.handle('project:add', async e => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, { title: __('Proje klasörü seç'), properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return addProject(r.filePaths[0]);
  });
  ipcMain.handle('project:remove', (_e, id) => {
    const gone = config.projects.find(p => p.id === id);
    if (gone && !config.removedProjects.some(r => norm(r) === norm(gone.path))) config.removedProjects.push(gone.path);
    config.projects = config.projects.filter(p => p.id !== id); saveConfig(); return config.projects;
  });
  ipcMain.handle('project:discover', async () => {
    const known = new Set(config.projects.map(p => norm(p.path)));
    return (await discoverProjects()).filter(p => !known.has(norm(p.path)));
  });
  ipcMain.handle('project:addPath', (_e, p) => { try { return typeof p === 'string' && fs.statSync(p).isDirectory() ? addProject(p) : null; } catch (_) { return null; } });
  ipcMain.handle('project:open', (_e, p) => { if (insideProject(p)) shell.openPath(p); });

  // files copied in Explorer: the clipboard holds a file list, not text. Read it the way
  // Windows Terminal pastes it (full paths). Electron has no API for CF_HDROP.
  ipcMain.handle('clipboard:files', () => new Promise(res => {
    if (IS_MAC) {
      // files copied in Finder: a plist of paths under NSFilenamesPboardType
      try {
        const xml = clipboard.read('NSFilenamesPboardType') || '';
        const list = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
        if (list.length) return res(list);
        const url = clipboard.read('public.file-url');
        return res(url ? [decodeURIComponent(url.replace(/^file:\/\//, ''))] : []);
      } catch (_) { return res([]); }
    }
    if (!IS_WIN) return res([]);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    (err, out) => res(err ? [] : String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean)));
  }));

  // Claude Code's own history retention (cleanupPeriodDays in ~/.claude/settings.json).
  // Only this key is touched; a file that does not parse is left alone.
  const USER_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
  const readUserSettings = () => {
    if (!fs.existsSync(USER_SETTINGS)) return {};
    const raw = fs.readFileSync(USER_SETTINGS, 'utf8').replace(/^﻿/, '');
    if (!raw.trim()) return {};
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(__('settings.json beklenen biçimde değil'));
    return j;
  };
  ipcMain.handle('claude:getCleanup', () => { try { const v = readUserSettings().cleanupPeriodDays; return Number.isFinite(v) ? v : null; } catch (_) { return null; } });
  ipcMain.handle('claude:setCleanup', (_e, days) => {
    const n = Math.round(Number(days));
    if (!(n >= 1 && n <= 3650)) throw new Error(__('Geçersiz gün sayısı'));
    let j;
    try { j = readUserSettings(); } catch (e) { throw new Error(__('~/.claude/settings.json okunamadı, dokunmadım: {error}', { error: e.message })); }
    j.cleanupPeriodDays = n;
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(USER_SETTINGS + '.tmp', JSON.stringify(j, null, 2) + '\n');
    fs.renameSync(USER_SETTINGS + '.tmp', USER_SETTINGS);
    return n;
  });

  // git / GitHub (read-only), limited to registered project folders
  const G = require('./git')({
    isProject: p => config.projects.some(x => norm(x.path) === norm(p)),
    insideProject, whereFirst, identity: () => config.identity,
  });
  ipcMain.handle('git:head', (_e, p) => G.head(p));
  ipcMain.handle('git:connect', (_e, p, url) => G.connect(p, url));
  ipcMain.handle('git:sync', (_e, p, action) => G.sync(p, action));
  ipcMain.handle('git:overview', (_e, p) => G.overview(p));
  ipcMain.handle('git:log', (_e, p, skip, n) => G.log(p, skip, n));
  ipcMain.handle('git:show', (_e, p, h) => G.show(p, h));
  ipcMain.handle('git:diff', (_e, p, kind, f) => G.diff(p, kind, f));
  ipcMain.handle('git:stash', (_e, p, ref) => G.stash(p, ref));
  ipcMain.handle('github:info', (_e, p, force) => G.github(p, force));
  // a link clicked in terminal output (the window already asked the user)
  ipcMain.handle('shell:openLink', async (_e, url) => {
    url = String(url || '');
    if (/^(https?|mailto):/i.test(url)) { await shell.openExternal(url); return true; }
    if (/^file:/i.test(url)) { const r = await shell.openPath(require('url').fileURLToPath(url)); return r ? { error: r } : true; }
    return false;
  });
  // plain paths in terminal output: which of the candidates exist (and are folders) — nothing else is read
  ipcMain.handle('path:probe', async (_e, list) => {
    const home = require('os').homedir();
    return Promise.all((Array.isArray(list) ? list : []).slice(0, 60).map(async p => {
      p = String(p || '').replace(/^~(?=[\\/]|$)/, home);
      if (!p || !path.isAbsolute(p) || p.length > 1024) return null;
      try { const st = await fs.promises.stat(p); return { dir: st.isDirectory() }; } catch (_) { return null; }
    }));
  });
  // Ctrl+click on such a path: a folder opens in the file manager, a file is shown selected in its folder
  ipcMain.handle('path:open', async (_e, p) => {
    p = String(p || '').replace(/^~(?=[\\/]|$)/, require('os').homedir());
    if (!path.isAbsolute(p)) return false;
    let st; try { st = await fs.promises.stat(p); } catch (_) { return { error: __('Bulunamadı: {path}', { path: p }) }; }
    if (st.isDirectory()) { const r = await shell.openPath(p); return r ? { error: r } : true; }
    shell.showItemInFolder(p); return true;
  });
  ipcMain.handle('shell:openGithub', (_e, url) => { if (/^https:\/\/github\.com\//i.test(String(url))) shell.openExternal(url); });

  // Claude and Codex sessions of a folder, newest first (Codex ones carry agent: 'codex')
  ipcMain.handle('history:list', async (_e, projectPath) => {
    const [a, b] = await Promise.all([listSessions(projectPath), CODEX.listSessions(projectPath).catch(() => [])]);
    return [...a, ...b].sort((x, y) => y.mtime - x.mtime).slice(0, 40);
  });
  ipcMain.handle('session:rename', (_e, sessionId, projectPath, title, agent) => (agent === 'codex' ? CODEX.rename(sessionId, title, saveConfig) : renameSession(sessionId, projectPath, title)));
  ipcMain.handle('usage:get', () => computeUsage());
  ipcMain.handle('live:list', () => scanLive());
  ipcMain.handle('live:tail', (_e, sid, offset, agent) => tailTranscript(sid, offset, agent && typeof agent === 'object' ? { agentId: String(agent.agentId || ''), toolUseId: String(agent.toolUseId || '') } : null));
  ipcMain.handle('live:takeover', (_e, sid) => takeOver(sid));
  ipcMain.handle('workflow:state', (_e, sid, runId) => workflowState(sid, runId));
  ipcMain.handle('workflow:detail', (_e, sid, runId) => workflowDetail(sid, runId));
  ipcMain.handle('mirror:start', (e, sid) => startMirror(sid, e.sender));
  ipcMain.on('mirror:input', (_e, id, data) => mirrorInput(id, data));
  ipcMain.on('mirror:stop', (_e, id) => stopMirror(id));
  ipcMain.on('mirror:scroll', (_e, id, n) => { const c = mirrors.get(id); if (c && Number.isFinite(n)) c.stdin.write('S ' + Math.max(0, Math.floor(n)) + '\n'); });

  ipcMain.handle('pty:spawn', (e, opts) => spawnTerminal(opts, e.sender));
  ipcMain.on('pty:write', (_e, id, data) => { const p = ptys.get(id); if (p) p.write(data); });
  ipcMain.on('pty:resize', (_e, id, cols, rows) => { const p = ptys.get(id); if (p) { try { p.resize(Math.max(20, cols), Math.max(5, rows)); } catch (_) {} } });
  ipcMain.on('pty:kill', (_e, id) => killPty(id));

  ipcMain.on('notify', (e, n) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body || '', silent: !config.settings.sound || config.settings.soundStyle !== 'windows', icon: appIcon(64, 1) });
    liveNotifications.add(note);
    const from = BrowserWindow.fromWebContents(e.sender) || win, wc = e.sender; // the window whose terminal it is
    note.on('click', () => {
      if (from === win || !alive(from)) showWindow(); else focusWin(from);
      if (n.tabId) sendTo(alive(from) ? wc : win.webContents, 'focus-tab', n.tabId);
    });
    // blink the taskbar button until the window is looked at
    if (alive(from) && !from.isFocused()) { from.flashFrame(true); from.once('focus', () => from.flashFrame(false)); }
    note.on('close', () => liveNotifications.delete(note));
    setTimeout(() => liveNotifications.delete(note), 60000);
    note.show();
  });
  ipcMain.on('tray:update', (e, stats) => {
    trayByWc.set(e.sender.id, stats || {}); sumTray();
    const w = BrowserWindow.fromWebContents(e.sender), base = (w && w._vsTitle) || 'VoxStorm';
    if (alive(w)) w.setTitle(stats && stats.pending ? `(${stats.pending}) ${base}` : base);
  });

  ipcMain.handle('welcome:data', () => welcomeData());
  // favourite projects: listed first on the welcome screen and in the start panel
  ipcMain.handle('project:fav', (_e, id, on) => {
    const p = config.projects.find(x => x.id === id); if (!p) return false;
    if (on) p.fav = true; else delete p.fav;
    saveConfig();
    send('projects-changed', config.projects);
    return true;
  });
  ipcMain.handle('welcome:addFolder', async () => {
    const r = await dialog.showOpenDialog(welcome || win, { title: __('Proje klasörü seç'), properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = addProject(r.filePaths[0]);
    send('projects-changed', config.projects);
    return p;
  });
  // action: 'select' | 'claude' | 'ide' | 'main' | 'settings'
  ipcMain.on('welcome:open', (_e, req) => {
    if (req && req.action === 'settings') { showWindow(); sendMain('open-settings'); closeWelcome(); return; }
    pendingOpen = req && (req.projectId || req.action === 'restoreAll') ? req : null;
    showWindow();
    // AI or IDE may be in a window of its own: that one acts on it
    const to = ownerWin(pendingOpen && pendingOpen.action === 'ide' ? 'ide' : 'claude');
    if (to !== win) focusWin(to);
    if (pendingOpen && alive(to)) sendTo(to.webContents, 'open-project', pendingOpen);
    closeWelcome();
  });
  ipcMain.handle('app:takePendingOpen', e => {
    const to = ownerWin(pendingOpen && pendingOpen.action === 'ide' ? 'ide' : 'claude');
    if (!pendingOpen || !alive(to) || to.webContents !== e.sender) return null;
    const p = pendingOpen; pendingOpen = null; return p;
  });
  ipcMain.on('welcome:close', () => closeWelcome());
  ipcMain.on('app:welcome', () => showWelcome());
  ipcMain.on('welcome:min', () => welcome && welcome.minimize());

  const senderWin = e => { const w = BrowserWindow.fromWebContents(e.sender); return alive(w) ? w : null; };
  ipcMain.on('win:min', e => { const w = senderWin(e); if (w) w.minimize(); });
  ipcMain.on('win:max', e => { const w = senderWin(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
  ipcMain.on('win:close', e => { const w = senderWin(e); if (w) w.close(); });
  // detached mode windows
  ipcMain.handle('win:detached', () => [...modeWins.keys()]);
  ipcMain.handle('win:detach', (_e, mode) => detachMode(mode));
  ipcMain.handle('win:attach', (e, mode) => { const w = senderWin(e); attachMode(mode || (w && w._vsMode)); return true; });
  ipcMain.handle('win:takeTabs', e => {
    const list = handoff.get(e.sender.id) || [];
    handoff.delete(e.sender.id);
    return list.map(t => {
      if (t.kind === 'watch') return t;
      const out = { ...t, buffer: ptyBuf.get(t.id) || '' };
      if (ptys.has(t.id)) ptyOwner.set(t.id, e.sender);
      else { out.exited = true; out.code = ptyGone.get(t.id) || 0; dropPty(t.id); }
      return out;
    });
  });
  // Ctrl+1/2/3 or a click on a mode that lives in another window: go there
  ipcMain.on('win:focusMode', (_e, mode) => {
    const w = modeWins.get(mode);
    if (alive(w)) focusWin(w);
    else if (alive(win) && MODE_RE.test(String(mode || ''))) { showWindow(); sendMain('win:set-mode', mode); }
  });
  ipcMain.on('win:modeMenu', (e, mode, canDetach) => {
    if (!MODE_RE.test(String(mode || ''))) return;
    const w = senderWin(e);
    const out = alive(modeWins.get(mode));
    Menu.buildFromTemplate(out ? [
      { label: __('Ayrı pencereye geç'), enabled: modeWins.get(mode) !== w, click: () => focusWin(modeWins.get(mode)) },
      { label: __('Ana pencereye geri al'), click: () => attachMode(mode) },
    ] : [
      { label: __('Ayrı pencerede aç'), enabled: !!canDetach, click: () => detachMode(mode) },
    ]).popup(w ? { window: w } : {});
  });
  ipcMain.on('app:quit', () => quitFlow());

  // IDE file access — limited to registered project folders
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', 'bin', 'obj', '.idea', '.vs']);
  ipcMain.handle('fs:list', async (_e, dir) => {
    if (!insideProject(dir)) throw new Error(__('Proje dışında'));
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents
      .filter(e => !IGNORE.has(e.name))
      .map(e => ({ name: e.name, dir: e.isDirectory(), path: path.join(dir, e.name) }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'tr') : a.dir ? -1 : 1));
  });
  ipcMain.handle('fs:read', async (_e, file) => {
    if (!insideProject(file)) throw new Error(__('Proje dışında'));
    const st = await fsp.stat(file);
    if (st.size > 3 * 1024 * 1024) return { error: __('Dosya çok büyük (3 MB üstü).') };
    const buf = await fsp.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return { error: __('İkili (binary) dosya, metin olarak açılamaz.') };
    return { text: buf.toString('utf8'), mtime: st.mtimeMs };
  });
  ipcMain.handle('fs:write', async (_e, file, text) => {
    if (!insideProject(file)) throw new Error(__('Proje dışında'));
    await fsp.writeFile(file, text, 'utf8');
    return true;
  });
  ipcMain.handle('fs:create', async (_e, file) => {
    if (!insideProject(file)) throw new Error(__('Proje dışında'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) await fsp.writeFile(file, '', 'utf8');
    return true;
  });
  // quick open, project search, rename / new folder / Recycle Bin, git colours, folder watcher
  require('./ide')({ ipcMain, shell, insideProject, send: (ch, ...a) => sendTo(ownerWin('ide') && ownerWin('ide').webContents, ch, ...a), isProjectRoot: p => config.projects.some(pr => norm(pr.path) === norm(p)) });
  // DB mode: connections, explorer, queries (closes its connections on quit)
  DB = require('./db')({ ipcMain, app, dialog, getWin: () => ownerWin('db'), DATA, getProjects: () => config.projects });
  // SSH mode: terminal + SFTP (PuTTY / WinSCP), tunnels, Remote Desktop launcher
  SSH = require('./ssh')({ ipcMain, dialog, getWin: () => ownerWin('ssh'), sendTo, DATA });
  // Docker: containers on this computer and on open SSH sessions
  DOCKER = require('./docker')({ ipcMain, shell, getSsh: () => SSH });
  THEMES = require('./themes')({ ipcMain, dialog, BrowserWindow, DATA });
  pluginsModule({
    app, ipcMain, protocol, shell, dialog, getWin: () => win, DATA, insideProject, getProjects: () => config.projects,
    // the plugins folder as a project, under a readable name the first time it is added
    ensureProject: (p, name) => {
      const known = config.projects.some(x => norm(x.path) === norm(p));
      const pr = addProject(p);
      if (!known) { pr.name = name; saveConfig(); send('projects-changed', config.projects); }
      return pr;
    },
  });
}
function addProject(p, auto) {
  const full = path.resolve(p);
  if (!auto) config.removedProjects = (config.removedProjects || []).filter(r => norm(r) !== norm(full));
  const existing = config.projects.find(x => norm(x.path) === norm(full));
  if (existing) return existing;
  // added: a new project counts as just used, so it is listed at the top until it has sessions
  const proj = { id: crypto.randomUUID().slice(0, 8), name: path.basename(full) || full, path: full, added: Date.now() };
  config.projects.push(proj);
  saveConfig();
  return proj;
}

/* ---------------- start ---------------- */
app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow()); // macOS: clicking the Dock icon brings the window back
app.on('before-quit', () => { isQuitting = true; for (const [m, w] of modeWins) rememberBounds(m, w); killAll(); saveConfigNow(); if (U) U.onQuit(); if (SSH) SSH.shutdown(); if (DOCKER) DOCKER.shutdown(); });
app.on('window-all-closed', e => e.preventDefault());

/* ---------------- Start Menu shortcuts (notification name, icon, click target) ---------------- */
function ensureShortcuts() {
  if (process.platform !== 'win32') return;
  try {
    const dir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    if (!fs.existsSync(dir)) return;
    // Electron.lnk, made on its own by an earlier dev run: bare electron.exe under the installed
    // app's ID, so the installed app's toasts read "Electron" and a click opened Electron's default app
    const stray = path.join(dir, 'Electron.lnk');
    try {
      const l = shell.readShortcutLink(stray);
      if (/^electron\.exe$/i.test(path.basename(l.target || '')) && /^VoxStorm/.test(l.appUserModelId || '')) fs.rmSync(stray, { force: true });
    } catch (_) {}
    if (app.isPackaged) {
      // the installer's shortcut: keep its toast activator in step with the app's fixed one
      const own = path.join(dir, 'VoxStorm.lnk');
      try {
        const l = shell.readShortcutLink(own);
        if (l.appUserModelId === AUMID && l.toastActivatorClsid !== app.toastActivatorCLSID) {
          shell.writeShortcutLink(own, 'update', { toastActivatorClsid: app.toastActivatorCLSID });
        }
      } catch (_) {}
      return;
    }
    // a PNG-in-ICO of the app logo for the shortcut
    const ico = path.join(DATA, 'voxstorm-dev.ico');
    const png = appIcon(256, 1).toPNG();
    const head = Buffer.alloc(22);
    head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
    head[6] = 0; head[7] = 0; head[8] = 0; head[9] = 0; // 256x256
    head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
    head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
    fs.writeFileSync(ico, Buffer.concat([head, png]));
    const appDir = app.getAppPath();
    shell.writeShortcutLink(path.join(dir, 'VoxStorm (Geliştirme).lnk'), 'create', {
      target: process.execPath,
      args: `"${appDir}"`,
      cwd: appDir,
      description: 'VoxStorm',
      icon: ico,
      iconIndex: 0,
      appUserModelId: AUMID,
      toastActivatorClsid: app.toastActivatorCLSID,
    });
  } catch (_) {}
}

app.whenReady().then(async () => {
  ensureShortcuts();
  if (IS_MAC && !app.isPackaged && app.dock) { try { app.dock.setIcon(appIcon(256, 2)); } catch (_) {} } // dev run: logo instead of Electron's
  // drop cached page files so an updated build never shows yesterday's styles
  try { await session.defaultSession.clearCache(); } catch (_) {}
  appMenu();
  await startHookServer();
  await setupAgentLink();
  writeAppendPrompt();
  // bring in every folder that has Claude Code history (on first launch and whenever a new one appears)
  await syncDiscovered().catch(() => {});
  setInterval(() => syncDiscovered().catch(() => {}), 10 * 60 * 1000);
  registerIpc();
  setupUpdater();
  if (firstRun || !config.identity) await detectIdentity({ firstLaunch: firstRun }).catch(() => {});
  computeUsage().catch(() => {});
  createWindow();
  createTray();
  U.start();
  watchLive();
});
