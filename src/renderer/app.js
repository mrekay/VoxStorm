'use strict';
/* VoxStorm renderer — talks to the main process only through window.api (see preload.js). */
/* global api, Terminal, FitAddon, CodeMirror */ // `api` comes from preload.js
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normPath = p => String(p || '').replace(/[\\/]/g, SEP).toLowerCase(); // SEP, IS_MAC: ui.js
// a path typed into a terminal: "C:\My Files\a.txt" on Windows, '/my files/a.txt' elsewhere
const quotePath = p => (IS_WIN ? (/[\s&()^%!,;=']/.test(p) ? `"${p}"` : p) : (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`));
const cleanErr = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const shorten = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

let CFG = null, INFO = null;
const S = {
  projects: [], history: {}, tabs: [], active: null,
  pending: [], agents: [], notifs: [], unread: 0, usage: null,
  lastTool: {}, modified: {}, mode: 'claude', collapsed: {}, showAll: {}, live: [], extAttn: new Map(),
};
const early = new Map();
let seq = 1;

const SHELL_ICONS = {
  pwsh: '<svg class="shi" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 2.5h11.3c.5 0 .8.4.7.9l-2.1 9.3c-.1.5-.5.8-1 .8H.8c-.5 0-.8-.4-.7-.9L2.2 3.3c.1-.5.5-.8 1-.8z" fill="#2c7cd6"/><path d="M4.3 5.2l3.4 2.6-4.6 2.9" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.7 10.9h3.2" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>',
  cmd: '<svg class="shi" viewBox="0 0 16 16" aria-hidden="true"><rect x=".75" y="1.75" width="14.5" height="12.5" rx="1.5" fill="#1b1b1f" stroke="#8a8f98" stroke-width="1"/><path d="M.75 4.5h14.5" stroke="#8a8f98" stroke-width="1"/><path d="M3.5 7.2l2.3 1.6-2.3 1.6" fill="none" stroke="#e8e8e8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.2 11.2h3.4" stroke="#e8e8e8" stroke-width="1.2" stroke-linecap="round"/></svg>',
  bash: '<i class="shi fa-brands fa-git-alt" style="color:#f05133" aria-hidden="true"></i>',
};
if (!IS_WIN) {
  SHELL_ICONS.zsh = '<i class="shi fa-solid fa-terminal" style="color:#8be28b" aria-hidden="true"></i>';
  SHELL_ICONS.bash = '<i class="shi fa-solid fa-dollar-sign" style="color:#c9c9d1" aria-hidden="true"></i>';
}
const SHELLS = IS_MAC ? { zsh: { name: 'Terminal (zsh)', exe: 'zsh' }, bash: { name: 'Bash', exe: 'bash' } }
  : !IS_WIN ? { bash: { name: 'Bash', exe: 'bash' }, zsh: { name: 'Zsh', exe: 'zsh' } } // Linux (main.js falls back to the login shell)
  : { pwsh: { name: 'PowerShell', exe: 'powershell' }, cmd: { name: __('Komut İstemi'), exe: 'cmd.exe' }, bash: { name: 'Git Bash', exe: 'bash.exe' } };
const DEFAULT_SHELL = IS_MAC ? 'zsh' : !IS_WIN ? 'bash' : 'pwsh';
const MONO_FONT = IS_MAC ? '"SF Mono", Menlo, Monaco, monospace'
  : !IS_WIN ? '"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", monospace'
  : '"Cascadia Mono", "Cascadia Code", Consolas, monospace';
const STATUS_TEXT = { running: __('Çalışıyor'), waiting: __('Kararını bekliyor'), done: __('Bitti'), idle: __('Hazır'), exited: __('Kapandı'), shell: __('Terminal') };
const STATUS_SHORT = { running: __('çalışıyor'), waiting: __('bekliyor'), done: __('bitti'), idle: __('açık'), exited: __('kapandı'), shell: __('terminal') };
const ICONS = { done: '<i class="fa-solid fa-check"></i>', decision: '<i class="fa-solid fa-hand"></i>', subagent: '<i class="fa-solid fa-robot"></i>', workflow: '<i class="fa-solid fa-diagram-project"></i>', system: '<i class="fa-solid fa-circle-info"></i>', plugin: '<i class="fa-solid fa-puzzle-piece"></i>' };
const SUB_TOOLS = new Set(['Task', 'Agent']);
const MODELS = [['', __('Claude Code varsayılanı')], ['opus', __('Opus (en güncel)')], ['sonnet', __('Sonnet (en güncel)')], ['haiku', __('Haiku (en güncel)')], ['fable', __('Fable (en güncel)')], ['__custom', __('Başka bir model…')]];
const EFFORTS = [['', __('Varsayılan')], ['low', __('Düşük')], ['medium', __('Orta')], ['high', __('Yüksek')], ['xhigh', __('Çok yüksek')], ['max', __('Maksimum')]];
const PERM_MODES = [
  ['', __('Claude Code varsayılanı'), __('Claude Code ayarlarındaki mod kullanılır')],
  ['manual', __('Her şeyi sor'), __('Dosya düzenleme ve komutlar için izin ister')],
  ['acceptEdits', __('Düzenlemeleri kabul et'), __('Dosya düzenlemelerini sormadan yapar, komutları sorar')],
  ['plan', __('Plan modu'), __('Önce plan çıkarır, onay vermeden değişiklik yapmaz')],
  ['auto', __('Otomatik (auto)'), __('Güvenli işlemleri kendi yapar, riskli olanları sorar')],
  ['dontAsk', __('Sorma, reddet'), __('İzin verilmemiş işlemleri sormadan reddeder')],
  ['bypassPermissions', __('İzinleri atla'), __('Hiçbir şey sormaz; tüm izin kontrolleri kapalı')],
];
const QUICK_MODES = [['plan', __('Plan modu')], ['auto', __('Otomatik (auto)')], ['acceptEdits', __('Düzenlemeleri kabul et')], ['bypassPermissions', __('İzinleri atla')]];
function claudeSummary() {
  const c = (CFG && CFG.settings.claude) || {};
  const parts = [];
  // a known model's label without its "(en güncel)" part, in whatever language it is shown
  const m = c.model && MODELS.find(([k]) => k === c.model);
  parts.push(c.model ? (m ? m[1].replace(/\s*\([^)]*\)$/, '') : c.model) : __('varsayılan model'));
  if (c.effort) parts.push(__('{effort} efor', { effort: (EFFORTS.find(([k]) => k === c.effort) || [0, c.effort])[1].toLowerCase() }));
  if (c.permissionMode) parts.push((PERM_MODES.find(([k]) => k === c.permissionMode) || [0, c.permissionMode])[1].toLocaleLowerCase('tr'));
  if (c.remoteControl) parts.push(__('RC açık'));
  if (c.chrome) parts.push('Chrome');
  if ((c.command || '').trim()) parts.push(__('özel komut'));
  return parts.join(' · ');
}
// Codex CLI (OpenAI) sessions: settings.codex = { model, effort, mode, search, command }
const CODEX_MODES = [
  ['', __('Varsayılan'), __('Codex kendi ayarını kullanır (config.toml)')],
  ['readonly', __('Salt okunur'), __('Dosya yazmadan ve komut çalıştırmadan önce sorar')],
  ['never', __('Sormadan çalış'), __('Hiç onay sormaz; korumalı alan (sandbox) açık kalır')],
  ['full', __('Tam yetki'), __('Onay sormaz, korumalı alan kapalı: her şeyi yapabilir')],
];
const CODEX_EFFORTS = [['', __('Varsayılan')], ['low', __('Düşük')], ['medium', __('Orta')], ['high', __('Yüksek')]];
function codexSummary() {
  const c = (CFG && CFG.settings.codex) || {};
  const parts = [c.model || __('varsayılan model')];
  if (c.effort) parts.push(__('{effort} efor', { effort: (CODEX_EFFORTS.find(([k]) => k === c.effort) || [0, c.effort])[1].toLocaleLowerCase('tr') }));
  if (c.mode) parts.push((CODEX_MODES.find(([k]) => k === c.mode) || [0, c.mode])[1].toLocaleLowerCase('tr'));
  if (c.search) parts.push(__('web araması'));
  if ((c.command || '').trim()) parts.push(__('özel komut'));
  return parts.join(' · ');
}
function agentPickHtml() {
  const cur = defaultAgent(); // Codex chosen but not installed: Claude is what is used
  return `<h4>${__('Varsayılan yapay zekâ')}</h4>
    <div class="seg"><button class="${cur === 'claude' ? 'on' : ''}" data-defagent="claude"><i class="fa-brands fa-claude"></i> Claude</button><button class="${cur === 'codex' ? 'on' : ''}${INFO.codex ? '' : ' dis'}" data-defagent="codex" ${INFO.codex ? '' : `aria-disabled="true" title="${esc(__('Codex kurulu değil. Kurmak için: npm i -g @openai/codex, ardından codex login. Kurduktan sonra VoxStorm’u yeniden başlat.'))}"`}><i class="fa-brands fa-openai"></i> Codex</button></div>
    <p class="set-note">${__('Ctrl+Shift+N, Proje Başlat ve projeye tıklayınca açılan yeni oturumlar bununla başlar. “+ Oturum ▾” menüsünden ikisini de ayrıca seçebilirsin; Codex için kısayol Ctrl+Shift+X.')}</p>`;
}
// "Claude'a sor" becomes "Codex'e sor" when Codex is the default (IDE, DB mode)
const aiName = () => (defaultAgent() === 'codex' ? 'Codex' : 'Claude');
const askLabel = () => (defaultAgent() === 'codex' ? __('Codex’e sor') : __('Claude’a sor'));
// which AI a new session starts with when none is chosen (settings: Varsayılan yapay zekâ)
const defaultAgent = () => (CFG && CFG.settings.defaultAgent === 'codex' && INFO && INFO.codex ? 'codex' : 'claude');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const proj = id => S.projects.find(p => p.id === id);
const tabById = id => S.tabs.find(t => t.id === id);
const tabBySession = sid => sid && S.tabs.find(t => t.sessionId === sid && t.kind !== 'watch');
const addr = () => ((CFG && CFG.settings.name) || '').trim();
const doneTitle = () => (addr() ? __('İş bitti, {name}', { name: addr() }) : __('İş bitti')); // the "done" notification's title
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
function rel(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return __('şimdi');
  if (m < 60) return __('{n} dk', { n: m });
  const h = Math.floor(m / 60); if (h < 24) return __('{n} sa', { n: h });
  const g = Math.floor(h / 24); if (g < 7) return __('{n} gün', { n: g });
  return new Date(ms).toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short' });
}
const fmtUsd = n => '$' + n.toLocaleString(I18N.locale(), { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });
const fmtTok = n => n >= 1e6 ? __('{v} M', { v: (n / 1e6).toLocaleString(I18N.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : n >= 1e3 ? __('{v} B', { v: Math.round(n / 1e3) }) : String(n);

/* ---------------- config ---------------- */
function mergeLocal(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) out[k] = k in base ? mergeLocal(base[k], extra[k]) : extra[k];
  return out;
}
function setCfg(patch) {
  CFG = mergeLocal(CFG, patch);
  return api.invoke('config:set', patch);
}

/* ---------------- toasts (in-app, small) ---------------- */
function toast(title, body) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
  $('#toasts').prepend(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------------- notifications ---------------- */
/* VoxStorm's own chimes, made with Web Audio so no sound files are needed:
   done = two rising notes, decision = a brighter four-note call, others = one soft note */
let audioCtx = null;
const CHIMES = {
  done: [[659.25, 0], [987.77, 0.13]],
  decision: [[880, 0], [1174.66, 0.11], [880, 0.22], [1174.66, 0.33]],
  other: [[783.99, 0]],
};
function playChime(type) {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.03;
    for (const [freq, at] of CHIMES[type] || CHIMES.other) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(0.2, t0 + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + at); o.stop(t0 + at + 0.55);
    }
  } catch (_) {}
}
function notify(type, title, body, tabId) {
  const looking = !!tabId && document.hasFocus() && S.active === tabId; // already looking at it
  if (!looking) { // a notification about the tab in front of you is not kept
    const it = { type, title, body, tabId, t: Date.now(), unread: $('#pop').hidden };
    S.notifs.unshift(it);
    S.notifs = S.notifs.slice(0, 80);
    if (it.unread) S.unread++;
  }
  const n = CFG.settings.notif;
  if (n.quiet || !n[type]) return;
  if (looking) return;
  if (CFG.settings.sound && (CFG.settings.soundStyle || 'claudelot') === 'claudelot') playChime(type);
  api.send('notify', { title, body, tabId });
}

/* ---------------- skins ---------------- */
const SKINS = [
  { k: 'violet', name: __('Gece moru'), sub: __('Koyu · mor vurgu'), c: ['#0b0a12', '#a78bfa', '#f2b155'] },
  { k: 'teal', name: __('Deniz'), sub: __('Windows temasına göre açık / koyu'), c: ['#e9eeef', '#0c7a71', '#3dc0b2'] },
  { k: 'mono', name: __('Grafit'), sub: __('Siyah-beyaz · durumlar renkli'), c: ['#0a0a0a', '#e8e8e8', '#f2b155'] },
  { k: 'paper', name: __('Kağıt'), sub: __('Açık · sıcak kâğıt, kiremit vurgu'), c:['#f4efe6', '#b4532a', '#2f6f5e'] },
];
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
/* Windows Terminal "Campbell" colours — what Claude Code looks like in a normal Windows terminal */
const CAMPBELL = {
  foreground: '#cccccc', black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
};
function termTheme() {
  const base = { background: cssVar('--term-bg'), foreground: cssVar('--term-fg'), cursor: cssVar('--term-cursor'), cursorAccent: cssVar('--term-bg'), selectionBackground: cssVar('--term-sel') };
  if (!CFG || (CFG.settings.termColors || 'windows') === 'windows') Object.assign(base, CAMPBELL, { cursor: '#cccccc', selectionBackground: '#3a3d41' });
  return base;
}
function applySkin(k) {
  k = String(k || 'mono');
  const own = k.startsWith('custom:') && window.Themes ? Themes.byId(k.slice(7)) : null; // themes.js
  if (own) Themes.show(own);
  else {
    if (window.Themes) Themes.show(null);
    if (k === 'violet' || k.startsWith('custom:')) delete document.documentElement.dataset.skin; else document.documentElement.dataset.skin = k;
  }
  if (window.Themes) Themes.repaintTerms();
  if (window.pluginHost) pluginHost.themeChanged();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applySkin(CFG.settings.skin));
function renderSkinMenu() {
  $('#skinMenu').innerHTML = `<div class="h">${__('Tema')}</div>` + skinOptions();
}
// built-in skins, then the user's own (themes.js) with an edit button, then "new" / "design with Claude"
const skinOptions = () => SKINS.concat((CFG.settings.customThemes || []).map(t => ({ k: 'custom:' + t.id, name: esc(t.name), sub: `${t.dark ? __('Koyu') : __('Açık')}${t.image ? ' · ' + __('resimli') : ''}${t.by ? ' · ' + __('{name} tasarladı', { name: esc(t.by) }) : ''}`, c: Themes.swatches(t), own: t.id })))
  .map(s => `<div class="skin-row"><button class="skin-opt" data-skin="${s.k}"><span class="sw3">${s.c.map(c => `<i style="background:${c}"></i>`).join('')}</span><span class="nm">${s.name}<small>${s.sub}</small></span><span class="ck">${s.k === CFG.settings.skin ? '✓' : ''}</span></button>${s.own ? `<button class="skin-ed" data-themeedit="${s.own}" title="${esc(__('Temayı düzenle'))}" aria-label="${esc(__('Temayı düzenle'))}"><i class="fa-solid fa-pen"></i></button>` : ''}</div>`).join('')
  + `<div class="skin-new"><button class="btn" data-themenew><i class="fa-solid fa-plus"></i> ${__('Yeni tema')}</button><button class="btn" data-themeclaude><i class="fa-solid fa-robot"></i> ${__('Claude ile tasarla')}</button></div>`;

/* ---------------- history & usage ---------------- */
async function refreshHistory(pid) {
  const p = proj(pid); if (!p) return;
  try { S.history[pid] = await api.invoke('history:list', p.path); } catch (_) { S.history[pid] = []; }
}
async function refreshAllHistory() { await Promise.all(S.projects.map(p => refreshHistory(p.id))); }
async function refreshUsage() {
  try { S.usage = await api.invoke('usage:get'); } catch (_) {}
  renderUsage(); renderStatus(); renderPanelBadges();
}

/* ---------------- terminals ---------------- */
function tabIcon(t) { if (t.kind === 'agent') return `<span class="dot ${t.status}"></span><i class="fa-solid fa-robot watch-ic" title="${esc(__('Alt ajanın konuşması (salt okunur)'))}"></i>`; if (t.kind === 'watch') return `<span class="dot ${t.status}"></span><i class="fa-solid fa-eye watch-ic" title="${esc(__('VoxStorm dışında açık, izleniyor'))}"></i>`; return t.kind === 'shell' ? (SHELL_ICONS[t.shell] || '<i class="shi fa-solid fa-terminal"></i>') : `<span class="dot ${t.status}"></span>${t.agent === 'codex' ? CODEX_IC : ''}`; }
const CODEX_IC = `<i class="fa-brands fa-openai codex-ic" title="${esc(__('Codex oturumu'))}"></i>`;

// adopt: a running terminal handed over by another window ({ id, sessionId, buffer, … }, see detached windows)
// agent: 'codex' for an OpenAI Codex session (kind stays 'claude': an AI session tab either way)
async function openTerminal({ kind = 'claude', shell, projectId, resume, title, overrides, adopt, group, agent }) {
  // already running in an outside terminal: follow it instead of starting a second copy
  if (resume && isExtLive(resume)) return openWatch(resume);
  const p = proj(projectId); if (!p) return null;
  // no agent given: a past session keeps its own, a new one uses the default from settings
  if (kind === 'claude' && !agent) {
    if (resume) { const h = (S.history[projectId] || []).find(x => x.id === resume); agent = (h && h.agent) || 'claude'; }
    else agent = defaultAgent();
  }
  if (kind !== 'claude' || agent !== 'codex') agent = undefined;
  if (resume) { const ex = tabBySession(resume); if (ex) { activate(ex.id); return ex; } }
  const el = document.createElement('div');
  el.className = 'term-pane';
  $('#termHost').appendChild(el);
  const term = new Terminal({
    fontFamily: MONO_FONT, fontSize: 13, lineHeight: 1.15,
    cursorBlink: true, scrollback: 8000, allowProposedApi: true, theme: termTheme(), linkHandler: termLinkHandler,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  $$('.term-pane').forEach(x => x.classList.remove('on'));
  el.classList.add('on');
  term.open(el);
  try { fit.fit(); } catch (_) {}
  const tab = {
    id: 'pending-' + (seq++), kind, shell, projectId, sessionId: null, term, fit, el, exited: false, agent,
    title: title || (kind === 'claude' ? __('Yeni oturum') : (SHELLS[shell] || SHELLS[DEFAULT_SHELL]).name + numberSuffix(projectId, shell)),
    status: kind === 'claude' ? 'idle' : 'shell',
    prompted: !!resume, // a brand-new session has nothing to resume until the first message
    group: group || null, // tab group id (tabgroups.js)
  };
  S.tabs.push(tab);
  S.active = tab.id;
  S.collapsed[projectId] = false; // show the project that just got a terminal
  renderAll();
  if (adopt) adoptTerminal(tab, adopt);
  else try {
    const res = await api.invoke('pty:spawn', { kind, agent, shell, cwd: p.path, resume, overrides, rcName: `${p.name} · VoxStorm`, cols: term.cols, rows: term.rows });
    tab.id = res.id; tab.sessionId = res.sessionId;
    S.active = tab.id;
    (early.get(res.id) || []).forEach(d => term.write(d));
    early.delete(res.id);
    saveOpenTabs();
  } catch (e) {
    tab.exited = true; tab.status = 'exited';
    term.write('\x1b[31m' + cleanErr(e) + '\x1b[0m\r\n');
  }
  term.onData(d => { if (!tab.exited) api.send('pty:write', tab.id, d); });
  term.onResize(({ cols, rows }) => { if (!tab.exited) api.send('pty:resize', tab.id, cols, rows); });
  // Claude Code puts the session's title in the terminal title bar: use it unless the user named the tab
  // (Codex does the same, as "title | folder")
  if (kind === 'claude') term.onTitleChange(raw => applyClaudeTitle(tab, raw));
  attachPathLinks(term, () => (proj(tab.projectId) || {}).path); // plain paths: Ctrl+click opens them (termpaths.js)
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (!IS_MAC && e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); }
      return false;
    }
    if (!IS_MAC && e.ctrlKey && k === 'v') return false; // browser paste event delivers the text
    return true;
  });
  activate(tab.id);
  return tab;
}
// the project a file belongs to (the deepest one, for nested projects)
function termFileProject(fp) {
  const n = normPath(fp);
  return S.projects.filter(x => n.startsWith(normPath(x.path).replace(/[\\/]+$/, '') + SEP))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;
}
// a project file opens in the IDE (at a line, counted from 1); false when it is outside every project
function openTermFile(fp, line, col, by) {
  const p = termFileProject(fp);
  if (!p) return false;
  if (S.mode !== 'ide') setMode('ide');
  if (IDE.project !== p.id) switchIdeProject(p.id);
  openFile(fp, line ? { line, col: col ? col - 1 : 0 } : undefined).then(() => revealInTree(fp, by));
  return true;
}
/* Links in terminal output (OSC 8: Claude Code links files and web pages). xterm's own handler
   asks with the browser's plain confirm(); this one asks in VoxStorm's style and knows each kind:
   a file in a project opens in the IDE, a web page in the browser (Ctrl+click: without asking). */
const termLinkHandler = {
  allowNonHttpProtocols: true,
  async activate(e, uri) {
    let u; try { u = new URL(uri); } catch (_) { return; }
    if (u.protocol === 'file:') {
      const fp = IS_WIN ? decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\') : decodeURIComponent(u.pathname);
      const line = (/^#L?(\d+)/i.exec(u.hash) || [])[1];
      if (openTermFile(fp, line ? +line : 0)) return;
      if (await uiConfirm({ title: __('Dosyayı aç'), icon: 'fa-file', message: fp, detail: IS_WIN ? __('Bu dosya projelerinin dışında. Windows’un varsayılan uygulamasıyla açılsın mı?') : __('Bu dosya projelerinin dışında. Sistemin varsayılan uygulamasıyla açılsın mı?'), ok: __('Aç') })) api.invoke('shell:openLink', uri);
      return;
    }
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      const web = u.protocol !== 'mailto:';
      if (e && modKey(e)) { api.invoke('shell:openLink', uri); return; }
      if (await uiConfirm({
        title: web ? __('Bağlantıyı aç') : __('E-posta bağlantısı'), icon: web ? 'fa-arrow-up-right-from-square' : 'fa-envelope',
        message: uri, detail: web ? __('Tarayıcıda açılacak: {host}\nTerminal bağlantılarının görünen yazısı gerçek adresten farklı olabilir; adresi kontrol et. {key}tık sormadan açar.', { host: u.host, key: IS_MAC ? '⌘' : 'Ctrl+' }) : __('Varsayılan e-posta uygulamasında açılacak.'),
        ok: web ? __('Tarayıcıda aç') : __('Aç'),
      })) api.invoke('shell:openLink', uri);
      return;
    }
    uiAlert({ title: __('Bağlantı açılamadı'), message: uri, detail: __('“{proto}” türündeki bağlantılar güvenlik nedeniyle açılmıyor.', { proto: u.protocol.replace(':', '') }) });
  },
};
// "✳ Fix the login bug" / "⠂ Fix the login bug" -> "Fix the login bug"; the bare app name is no title
function claudeTermTitle(raw) {
  const s = String(raw || '').replace(/[⠀-⣿]/g, '').replace(/^[\s•·*✱-❋⏺●○◆◇★☆-]+/u, '').replace(/\s+/g, ' ').trim();
  return !s || /^claude( code)?$/i.test(s) ? '' : s;
}
let titleTimer = null;
// Codex: "Fix the login bug | myproject"; before the first message only the folder name, or the
// launcher's own title (cmd.exe's path)
function codexTermTitle(raw, tab) {
  let s = String(raw || '').replace(/[⠀-⣿]/g, '').replace(/\s+/g, ' ').trim();
  const p = proj(tab.projectId), dir = p ? baseName(p.path) : '';
  if (dir && s.endsWith(' | ' + dir)) s = s.slice(0, -(dir.length + 3)).trim();
  s = s.replace(/^\[[^\]]{0,8}\]\s*Action Required\s*(\|\s*)?/i, '').trim(); // while it waits for an approval
  if (!s || s === dir || /[\\/]/.test(s) && /\.exe\b/i.test(s) || /^codex$/i.test(s)) return '';
  return s;
}
function applyClaudeTitle(tab, raw) {
  if (tab.renamed) return;
  const v = tab.agent === 'codex' ? codexTermTitle(raw, tab) : claudeTermTitle(raw);
  if (!v) return;
  const t = shorten(v, 48);
  if (t === tab.title) return;
  tab.title = t;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => { renderAll(); saveOpenTabs(); }, 300);
}
function numberSuffix(pid, shell) {
  const n = S.tabs.filter(t => t.projectId === pid && t.shell === shell).length;
  return n ? ' ' + (n + 1) : '';
}
function fitActive() {
  const t = tabById(S.active);
  if (t && t.fit && t.el.offsetParent) { try { t.fit.fit(); } catch (_) {} }
}
// the user has seen this tab: its notifications leave the bell too
function seenTab(id) {
  if (!id || !document.hasFocus() || !S.notifs.some(n => n.tabId === id)) return false;
  S.unread = Math.max(0, S.unread - S.notifs.filter(n => n.tabId === id && n.unread).length);
  S.notifs = S.notifs.filter(n => n.tabId !== id);
  return true;
}
function activate(id) {
  const t = tabById(id); if (!t) return;
  S.active = id;
  seenTab(id);
  t.attn = null;
  if (t.kind === 'watch') S.extAttn.delete(t.sessionId);
  if (S.mode === 'ide' && t.projectId && t.projectId !== IDE.project) { IDE.project = t.projectId; showFile(); }
  $$('.term-pane').forEach(x => x.classList.toggle('on', x === t.el));
  renderAll();
  // with many tabs the strip scrolls sideways: bring the activated one into view (sidebar click, Ctrl+Tab, notification)
  for (const sel of ['#tabs .tab.active', '#ptabs .ptab.on']) { const on = $(sel); if (on && on.offsetParent) on.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  requestAnimationFrame(() => {
    fitActive();
    if (t.kind === 'watch') setWatchView(t, t.view);
    else if (t.kind === 'agent') { const log = t.el.querySelector('.watch-log'); if (t.stick) log.scrollTop = log.scrollHeight; }
    else if (t.term) t.term.focus();
  });
}
async function closeTab(id) {
  let t = tabById(id); if (!t) return;
  if (t.kind !== 'watch' && t.kind !== 'agent' && !t.exited && (t.status === 'running' || t.status === 'waiting')) {
    if (!(await uiConfirm({ title: __('Terminal kapatılsın mı?'), message: __('"{title}" hâlâ çalışıyor.', { title: t.title }), detail: __('Claude oturumu geçmişte kalır, sonra devam ettirebilirsin.'), ok: __('Kapat'), danger: true }))) return;
    t = tabById(id); if (!t) return;
  }
  if (t.kind === 'watch') { clearInterval(t.timer); if (t.mirror) api.send('mirror:stop', t.mirror); }
  else if (t.kind === 'agent') clearInterval(t.timer);
  else if (!t.exited) api.send('pty:kill', t.id);
  if (window.closedTabs) closedTabs.remember(t); // Ctrl+Alt+T brings it back
  if (t.term) t.term.dispose();
  t.el.remove();
  const idx = S.tabs.indexOf(t);
  S.tabs.splice(idx, 1);
  saveOpenTabs();
  S.pending = S.pending.filter(p => p.tabId !== id);
  S.agents = S.agents.filter(a => a.tabId !== id);
  if (S.active === id) {
    const same = S.tabs.filter(x => x.projectId === t.projectId);
    const next = (S.mode === 'ide' ? same : S.tabs)[Math.max(0, Math.min(idx, S.tabs.length) - 1)] || same[0] || (S.mode === 'ide' ? null : S.tabs[0]);
    S.active = next ? next.id : null;
    if (next) activate(next.id);
  }
  if (t.kind === 'claude') refreshHistory(t.projectId).then(renderSide);
  renderAll();
}
api.on('pty:data', (id, d) => {
  const t = tabById(id);
  if (t) t.term.write(d);
  else { if (!early.has(id)) early.set(id, []); early.get(id).push(d); }
});
api.on('pty:exit', (id, code) => {
  const t = tabById(id); if (!t) return;
  t.exited = true; t.status = 'exited';
  t.term.write(`\r\n\x1b[90m${code ? __('[İşlem sona erdi · çıkış kodu {code}. Sekmeyi kapatabilirsin.]', { code }) : __('[İşlem sona erdi. Sekmeyi kapatabilirsin.]')}\x1b[0m\r\n`);
  S.pending = S.pending.filter(p => p.tabId !== id);
  S.agents = S.agents.filter(a => a.tabId !== id);
  if (t.kind === 'claude') refreshHistory(t.projectId).then(renderSide);
  renderAll();
});
new ResizeObserver(() => fitActive()).observe($('#termHost'));

/* ---------------- Claude Code hook events ---------------- */
function toolSummary(input) {
  if (!input) return '';
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  if (input.description) return input.description;
  try { return JSON.stringify(input).slice(0, 300); } catch (_) { return ''; }
}
function addPending(t, card) {
  S.pending = S.pending.filter(p => !(p.tabId === t.id && p.kind === card.kind));
  S.pending.push({ id: 'd' + (seq++), tabId: t.id, t: Date.now(), ...card });
  t.status = 'waiting';
}
function clearPending(t) { S.pending = S.pending.filter(p => p.tabId !== t.id); }
function addAgent(t, kind, name, toolUseId, type) { S.agents.push({ id: 'a' + (seq++), tabId: t.id, sessionId: t.sessionId, kind, name: shorten(name, 80), type: type || '', toolUseId, t: Date.now() }); }
function finishAgent(t, toolUseId, kind) {
  let a = toolUseId && S.agents.find(x => x.toolUseId === toolUseId);
  if (!a && !toolUseId) a = S.agents.find(x => x.tabId === t.id && x.kind === kind && !x.bg);
  if (a) { S.agents = S.agents.filter(x => x !== a); agentEnded(a); }
  return a;
}
// a background agent (run_in_background, or sent to the background with Ctrl+B) keeps
// running after its Agent call returns; it ends with SubagentStop, not PostToolUse
const isAsyncLaunch = r => !!r && typeof r === 'object' && (r.isAsync === true || r.status === 'async_launched');
// background workflows have no hook for their end: poll for the run snapshot Claude Code writes
let wfTimer = null;
function watchWorkflows() {
  if (wfTimer) return;
  wfTimer = setInterval(async () => {
    const runs = S.agents.filter(a => a.kind === 'workflow' && a.bg && a.runId);
    if (!runs.length) { clearInterval(wfTimer); wfTimer = null; return; }
    let changed = false;
    for (const a of runs) {
      let st = null;
      try { st = await api.invoke('workflow:state', a.sessionId, a.runId); } catch (_) {}
      if (!st || !st.done || !S.agents.includes(a)) continue;
      S.agents = S.agents.filter(x => x !== a); changed = true;
      const t = tabById(a.tabId);
      const failed = st.error || /fail|error|cancel|kill|abort/i.test(st.status || '');
      notify('workflow', failed ? __('Workflow hatayla bitti') : __('Workflow bitti'),`${shorten(a.name, 60)}${t ? ' · ' + t.title : ''}`, a.tabId);
    }
    if (changed) renderAll();
  }, 3000);
}
// an open conversation tab of an agent stops showing it as running
function agentEnded(a) {
  const v = S.tabs.find(x => x.kind === 'agent' && x.agentKey === a.id);
  if (v) { v.status = 'done'; pollWatch(v); }
}
api.on('hook', ev => {
  S.lastHook = { name: ev.hook_event_name, session: ev.session_id, at: Date.now() };
  if (ev.vs_agent === 'codex') return codexHook(ev);
  const t = tabBySession(ev.session_id);
  if (!t) return;
  const name = ev.hook_event_name, tool = ev.tool_name, input = ev.tool_input || {};
  if (name === 'SessionStart' && t.pendingPrompt) sendPendingPrompt(t);
  if (name === 'UserPromptSubmit') {
    clearPending(t); t.status = 'running';
    if (t.title === __('Yeni oturum') && !t.renamed && ev.prompt) t.title = shorten(ev.prompt, 48);
    if (!t.prompted) { t.prompted = true; saveOpenTabs(); }
  } else if (name === 'PreToolUse') {
    S.lastTool[t.id] = { tool, input };
    if (t.status !== 'waiting') t.status = 'running';
    if (SUB_TOOLS.has(tool)) {
      const n = input.description || input.subagent_type || __('Alt ajan');
      addAgent(t, 'subagent', n, ev.tool_use_id, input.subagent_type);
      notify('subagent', __('Alt ajan açıldı'), `${shorten(n, 60)} · ${t.title}`, t.id);
    } else if (tool === 'Workflow') {
      const sm = /\bname\s*:\s*(['"`])([^'"`\n]{1,80})\1/.exec(String(input.script || '')); // the script's meta.name
      const n = input.name || (sm && sm[2]) || input.description || 'Workflow';
      addAgent(t, 'workflow', n, ev.tool_use_id);
      notify('workflow', __('Workflow açıldı'), `${shorten(n, 60)} · ${t.title}`, t.id);
    } else if (tool === 'AskUserQuestion') {
      const q = (input.questions || [])[0] || {};
      addPending(t, { kind: 'question', q: q.question || __('Claude bir soru soruyor'), options: (q.options || []).map(o => (o && o.label) || String(o)).slice(0, 6), multi: !!q.multiSelect, more: (input.questions || []).length > 1 });
      notify('decision', __('Claude soru soruyor'), `${t.title}: ${q.question || ''}`, t.id);
    } else if (tool === 'ExitPlanMode') {
      addPending(t, { kind: 'plan', q: __('Plan onayını bekliyor'), detail: String(input.plan || '').slice(0, 2000) });
      notify('decision', __('Plan onayı bekleniyor'), t.title, t.id);
    }
  } else if (name === 'PostToolUse') {
    const r = ev.tool_response;
    const bgAgent = (SUB_TOOLS.has(tool) || tool === 'Workflow') && isAsyncLaunch(r) && !(tool === 'Workflow' && r.error) && S.agents.find(x => x.toolUseId === ev.tool_use_id);
    if (bgAgent) {
      bgAgent.bg = true;
      if (r.agentId) bgAgent.agentId = String(r.agentId);
      if (r.runId) { bgAgent.runId = String(r.runId); watchWorkflows(); }
    }
    else if (SUB_TOOLS.has(tool) || tool === 'Workflow') {
      const a = finishAgent(t, ev.tool_use_id, tool === 'Workflow' ? 'workflow' : 'subagent');
      if (a) notify(a.kind, a.kind === 'workflow' ? __('Workflow bitti') : __('Alt ajan bitti'),`${shorten(a.name, 60)} · ${t.title}`, t.id);
    }
    if (EDIT_TOOLS.has(tool) && (input.file_path || input.notebook_path)) fileChangedByClaude(input.file_path || input.notebook_path, tool === 'Write');
    clearPending(t);
    if (t.status === 'waiting') t.status = 'running';
  } else if (name === 'Notification') {
    const msg = ev.message || '';
    const type = ev.notification_type || '';
    if (type === 'permission_prompt' || /permission/i.test(msg)) {
      if (!S.pending.some(p => p.tabId === t.id && (p.kind === 'question' || p.kind === 'plan'))) {
        const lt = S.lastTool[t.id] || {};
        addPending(t, { kind: 'permission', q: msg || __('İzin istiyor'), detail: lt.tool ? `${lt.tool}: ${toolSummary(lt.input)}` : '' });
        notify('decision', __('Kararını bekliyor'),`${t.title}: ${msg}`, t.id);
      }
    }
  } else if (name === 'SubagentStop') {
    let a = S.agents.find(x => x.tabId === t.id && x.kind === 'subagent' && ((ev.vs_tool_use_id && x.toolUseId === ev.vs_tool_use_id) || (ev.agent_id && x.agentId === ev.agent_id)));
    if (!a && !ev.vs_tool_use_id) a = S.agents.find(x => x.tabId === t.id && x.kind === 'subagent' && x.bg); // oldest background one
    // foreground agents are finished by their PostToolUse right after this
    if (a && a.bg) {
      S.agents = S.agents.filter(x => x !== a); agentEnded(a);
      notify('subagent', __('Alt ajan bitti'),`${shorten(a.name, 60)} · ${t.title}`, t.id);
    } else if (a && ev.agent_id) a.agentId = ev.agent_id;
  } else if (name === 'Stop') {
    clearPending(t);
    const was = t.status;
    t.status = 'done';
    S.agents = S.agents.filter(a => a.tabId !== t.id || a.bg); // background agents outlive the turn
    if (was === 'running' || was === 'waiting') notify('done', doneTitle(), `${t.title} ·${(proj(t.projectId) || {}).name || ''}`, t.id);
    refreshHistory(t.projectId).then(renderSide);
  } else if (name === 'SessionEnd') {
    refreshHistory(t.projectId).then(renderSide);
  }
  renderAll();
});

/* Codex CLI hook events (main.js tags them vs_agent/vs_pty). The terminal id finds the tab even
   before the session id is known; SessionStart (or any later event) brings the session id. */
// Codex runs most commands to completion in a moment; one still going after this long is shown
// in the agents list as a background terminal until its PostToolUse arrives
const CX_TERM_SHOW = 4000;
const shownAgents = () => S.agents.filter(a => a.kind !== 'term' || (Date.now() - a.t >= CX_TERM_SHOW && (tabById(a.tabId) || {}).status !== 'waiting'));
function codexHook(ev) {
  const t = (ev.vs_pty && tabById(ev.vs_pty)) || tabBySession(ev.session_id);
  if (!t || t.agent !== 'codex') return;
  const name = ev.hook_event_name, input = ev.tool_input || {};
  // a subagent shares the terminal: its own session id must not replace the tab's, and only its
  // commands matter here (its start and end arrive from the parent as SubagentStart / SubagentStop)
  if (t.cxKids && t.cxKids.has(ev.session_id)) {
    if (name === 'PreToolUse' && ev.tool_name === 'Bash' && ev.tool_use_id) { addAgent(t, 'term', input.command || __('Komut'),ev.tool_use_id); setTimeout(renderAll, CX_TERM_SHOW + 100); }
    else if (name === 'PostToolUse' && ev.tool_use_id) S.agents = S.agents.filter(x => !(x.kind === 'term' && x.toolUseId === ev.tool_use_id));
    return renderAll();
  } else if (ev.session_id && t.sessionId !== ev.session_id) { t.sessionId = ev.session_id; saveOpenTabs(); }
  const where = () => `${t.title} · ${(proj(t.projectId) || {}).name || ''}`;
  if (name === 'SessionStart' && t.pendingPrompt) sendPendingPrompt(t);
  else if (name === 'UserPromptSubmit') {
    clearPending(t); t.status = 'running';
    if (t.title === __('Yeni oturum') && !t.renamed && ev.prompt) t.title = shorten(ev.prompt, 48);
    if (!t.prompted) { t.prompted = true; saveOpenTabs(); }
  } else if (name === 'PermissionRequest') {
    const what = input.command || input.file_path || toolSummary(input);
    addPending(t, { kind: 'permission', agent: 'codex', q: input.description || __('Codex izin istiyor'), detail: (ev.tool_name ? ev.tool_name + ': ' : '') + String(what || '').slice(0, 600) });
    notify('decision', __('Codex izin istiyor'),`${t.title}: ${input.description || what || ''}`, t.id);
  } else if (name === 'PreToolUse') {
    const tool = String(ev.tool_name || '');
    // a shell command: listed only if it is still running a few seconds later (a background terminal)
    if (tool === 'Bash' && ev.tool_use_id) {
      addAgent(t, 'term', input.command || __('Komut'), ev.tool_use_id);
      setTimeout(renderAll, CX_TERM_SHOW + 100);
    } else if (/spawn_agent$/.test(tool)) (t.cxSpawn = t.cxSpawn || []).push(input.task_name || input.agent_type || '');
  } else if (name === 'SubagentStart') {
    if (ev.agent_id) (t.cxKids = t.cxKids || new Set()).add(ev.agent_id);
    const q = t.cxSpawn || [];
    const n = String(q.shift() || '').replace(/^\/?root\//, '').replace(/[_-]+/g, ' ').trim() || __('Alt ajan');
    S.agents.push({ id: 'a' + (seq++), tabId: t.id, sessionId: t.sessionId, kind: 'subagent', agent: 'codex', agentId: ev.agent_id, name: shorten(n, 80), type: ev.agent_type && ev.agent_type !== 'default' ? ev.agent_type : '', t: Date.now() });
    notify('subagent', __('Alt ajan açıldı'), `${shorten(n, 60)} · ${t.title}`, t.id);
  } else if (name === 'SubagentStop') {
    const a = S.agents.find(x => x.tabId === t.id && x.kind === 'subagent' && x.agentId === ev.agent_id);
    if (a) { S.agents = S.agents.filter(x => x !== a); notify('subagent', __('Alt ajan bitti'),`${shorten(a.name, 60)} · ${t.title}`, t.id); }
  } else if (name === 'PostToolUse') {
    clearPending(t);
    if (ev.tool_use_id) S.agents = S.agents.filter(x => !(x.kind === 'term' && x.toolUseId === ev.tool_use_id));
    if (t.status === 'waiting' || t.status === 'idle' || t.status === 'done') t.status = 'running';
  } else if (name === 'Stop') {
    clearPending(t);
    // a turn's end leaves no command or subagent of it running that we could still hear about
    S.agents = S.agents.filter(x => x.tabId !== t.id);
    t.cxSpawn = [];
    const was = t.status;
    t.status = 'done';
    if (was === 'running' || was === 'waiting') notify('done', doneTitle(), where(), t.id);
    refreshHistory(t.projectId).then(renderSide);
  }
  renderAll();
}

function decide(id, c) {
  const p = S.pending.find(x => x.id === id); if (!p) return;
  const t = tabById(p.tabId);
  if (c === 'goto') { if (S.mode !== 'claude') setMode('claude'); if (t) activate(t.id); return; }
  if (t && !t.exited) {
    // Codex's approval: y = yes, p = don't ask again for such commands, Esc = no
    const keys = t.agent === 'codex' ? { yes: 'y', always: 'p', no: '\x1b' } : { yes: '1', always: '2', no: '\x1b' };
    if (keys[c]) api.send('pty:write', t.id, keys[c]);
    else if (c.startsWith('opt')) api.send('pty:write', t.id, String(+c.slice(3) + 1));
    t.status = 'running';
  }
  S.pending = S.pending.filter(x => x !== p);
  renderAll();
}

/* ---------------- live sessions opened outside VoxStorm ----------------
   The main process lists running Claude sessions that none of our terminals own.
   Clicking one opens a read-only "watch" tab that follows its transcript, so an
   outside session is never started a second time with --resume. */
const LIVE_ST = { busy: 'running', waiting: 'waiting', idle: 'idle' };
const waitText = w => !w ? __('Kararını bekliyor') : /permission|izin/i.test(w) ? __('İzin bekliyor') : /dialog/i.test(w) ? __('Bir soruya cevap bekliyor') : w;
const projOfCwd = cwd => cwd && S.projects.find(p => normPath(p.path) === normPath(cwd));
const outsideOf = pid => S.live.filter(s => { const p = projOfCwd(s.cwd); return p && p.id === pid; });
const isExtLive = sid => S.live.some(s => s.sessionId === sid);
const watchTab = sid => S.tabs.find(t => t.kind === 'watch' && t.sessionId === sid);
const extWaiting = () => S.live.filter(s => s.status === 'waiting');
const pendingCount = () => S.pending.length + extWaiting().length;

const liveWorked = new Set(); // outside sessions seen working since their last 'done'
function setLive(list) {
  if (!ownsAI()) list = []; // outside sessions are followed (and notified) only where AI mode is
  const prev = new Map(S.live.map(s => [s.sessionId, s.status]));
  S.live = (list || []).filter(s => !S.tabs.some(t => t.kind !== 'watch' && t.sessionId === s.sessionId));
  for (const s of S.live) {
    const was = prev.get(s.sessionId);
    if (!was) continue;
    const w = watchTab(s.sessionId);
    const where = `${shorten(s.title, 60)} · ${__('{name} (dışarıda)', { name: (projOfCwd(s.cwd) || {}).name || baseName(s.cwd) })}`;
    // a turn can pass through 'waiting' (permission asked) before it finishes
    if (s.status === 'busy' || s.status === 'waiting') liveWorked.add(s.sessionId);
    const target = w ? w.id : 'watch:' + s.sessionId; // a click opens the session even if no tab is open yet
    if (!w && s.status === 'waiting' && was !== 'waiting') S.extAttn.set(s.sessionId, 'ask');
    if (s.status === 'idle' && was !== 'idle' && liveWorked.has(s.sessionId) && !w) S.extAttn.set(s.sessionId, 'done');
    if (s.status === 'busy') S.extAttn.delete(s.sessionId);
    if (s.status === 'idle' && was !== 'idle' && liveWorked.delete(s.sessionId)) notify('done', doneTitle(), where, target);
    if (was !== 'waiting' && s.status === 'waiting') notify('decision', __('Kararını bekliyor'),`${where}: ${waitText(s.waitingFor)}`, target);
  }
  for (const t of S.tabs.filter(x => x.kind === 'watch')) {
    const s = S.live.find(x => x.sessionId === t.sessionId);
    t.ext = s || null;
    t.status = s ? LIVE_ST[s.status] || 'idle' : 'exited';
    if (s) t.title = shorten(s.title, 48);
    renderWatchBar(t);
  }
  renderAll();
}

function openWatch(sid) {
  const ex = watchTab(sid);
  if (ex) { if (S.mode === 'ide' && ex.projectId && ex.projectId !== IDE.project) switchIdeProject(ex.projectId); activate(ex.id); return ex; }
  const s = S.live.find(x => x.sessionId === sid);
  const p = s && projOfCwd(s.cwd);
  const el = document.createElement('div');
  el.className = 'term-pane watch-pane';
  el.innerHTML = `<div class="watch-bar"></div><div class="watch-term"><div class="watch-note">${__('Terminale bağlanılıyor…')}</div></div><div class="watch-log" hidden><div class="watch-note">${__('Konuşma okunuyor…')}</div></div>`;
  $('#termHost').appendChild(el);
  const tab = {
    id: 'w' + (seq++), kind: 'watch', sessionId: sid, projectId: p ? p.id : null, cwd: s ? s.cwd : '',
    el, exited: false, prompted: false, ext: s || null, offset: 0, first: true, stick: true, view: 'term',
    title: shorten(s ? s.title : __('Oturum'), 48), status: s ? LIVE_ST[s.status] || 'idle' : 'exited',
    mirror: null, mirrorState: 'connecting', fontSize: 13,
  };
  const log = el.querySelector('.watch-log');
  log.addEventListener('scroll', () => { tab.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60; });
  log.addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a) return;
    e.preventDefault();
    if (/^https?:/i.test(a.getAttribute('href'))) window.open(a.getAttribute('href'));
  });
  el.querySelector('.watch-bar').addEventListener('click', e => {
    const b = e.target.closest('[data-wview]'); if (b) setWatchView(tab, b.dataset.wview);
  });
  S.tabs.push(tab);
  if (tab.projectId) S.collapsed[tab.projectId] = false;
  renderWatchBar(tab);
  pollWatch(tab);
  tab.timer = setInterval(() => pollWatch(tab), 1500);
  connectMirror(tab);
  if (S.mode === 'ide' && tab.projectId && tab.projectId !== IDE.project) switchIdeProject(tab.projectId);
  activate(tab.id);
  return tab;
}
/* A subagent's own conversation in a read-only tab, followed live while it runs. */
function openAgentView(id) {
  const a = S.agents.find(x => x.id === id); if (!a) return;
  if (S.mode !== 'claude' && S.mode !== 'ide') setMode('claude');
  const ex = S.tabs.find(t => t.kind === 'agent' && t.agentKey === a.id);
  if (ex) { activate(ex.id); return ex; }
  const parent = tabById(a.tabId);
  const sid = a.sessionId || (parent && parent.sessionId);
  if (!sid) { toast(__('Ajanın oturumu bulunamadı')); return; }
  const el = document.createElement('div');
  el.className = 'term-pane watch-pane';
  el.innerHTML = `<div class="watch-bar"></div><div class="watch-log"><div class="watch-note">${__('Konuşma okunuyor…')}</div></div>`;
  $('#termHost').appendChild(el);
  const tab = {
    id: 'g' + (seq++), kind: 'agent', agentKey: a.id, parentSid: sid, agentId: a.agentId || null, toolUseId: a.toolUseId,
    projectId: parent ? parent.projectId : null, el, exited: false, prompted: false, offset: 0, first: true, stick: true,
    title: shorten(a.name, 40), status: 'running',
  };
  const log = el.querySelector('.watch-log');
  log.addEventListener('scroll', () => { tab.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60; });
  log.addEventListener('click', e => {
    const l = e.target.closest('a[href]'); if (!l) return;
    e.preventDefault();
    if (/^https?:/i.test(l.getAttribute('href'))) window.open(l.getAttribute('href'));
  });
  el.querySelector('.watch-bar').innerHTML = `<span class="dot running"></span><span class="wb-t"><b>${__('Alt ajan: {name}', { name: esc(a.name) })}</b>${a.type ? ' · ' + esc(a.type) : ''}<small>${__('{title} oturumunun ajanı · salt okunur, ajanın kendi konuşması', { title: esc(parent ? parent.title : '') })}</small></span>`
    + (parent ? `<button class="btn" data-tab="${parent.id}"><i class="fa-solid fa-arrow-left"></i> ${__('Ana oturuma dön')}</button>` : '');
  S.tabs.push(tab);
  pollWatch(tab);
  tab.timer = setInterval(() => pollWatch(tab), 1500);
  activate(tab.id);
  return tab;
}
/* the live terminal of the outside session, mirrored into an xterm */
async function connectMirror(t) {
  if (!t.ext || !IS_WIN) { t.mirrorState = 'off'; setWatchView(t, 'log'); return; } // Windows-only console attach
  try {
    const r = await api.invoke('mirror:start', t.sessionId);
    if (!S.tabs.includes(t)) { api.send('mirror:stop', r.id); return; }
    t.mirror = r.id;
  } catch (e) { mirrorFailed(t, cleanErr(e)); }
}
function mirrorFailed(t, msg) {
  t.mirror = null; t.mirrorState = 'failed';
  const box = t.el.querySelector('.watch-term');
  if (!t.term) box.innerHTML = `<div class="watch-note">${esc(msg || __('Terminale bağlanılamadı.'))}<br>${__('Konuşma görünümüne geçildi.')}</div>`;
  renderWatchBar(t);
  if (!t.term) setWatchView(t, 'log');
}
function mirrorTerm(t) {
  if (t.term) return t.term;
  const box = t.el.querySelector('.watch-term');
  box.innerHTML = '';
  const term = new Terminal({
    fontFamily: MONO_FONT, fontSize: t.fontSize, lineHeight: 1.15,
    cursorBlink: true, scrollback: 0, allowProposedApi: true, theme: termTheme(), linkHandler: termLinkHandler,
  });
  term.open(box);
  attachPathLinks(term, () => t.cwd || (proj(t.projectId) || {}).path);
  term.onData(d => { if (t.mirror) { if (t.sReq) mirrorScroll(t, 0); api.send('mirror:input', t.mirror, d); } });
  // scrolling: the history sits in the outside console's buffer, so ask the mirror for an
  // older slice of it instead of scrolling the (scrollback-less) xterm
  const bar = document.createElement('div');
  bar.className = 'mscroll'; bar.hidden = true;
  bar.innerHTML = '<div class="mthumb"></div>';
  const live = document.createElement('button');
  live.className = 'mlive'; live.hidden = true;
  live.innerHTML = `<i class="fa-solid fa-arrow-down"></i> ${__('Canlıya dön')}`;
  live.onclick = () => { mirrorScroll(t, 0); term.focus(); };
  box.append(bar, live);
  let acc = 0;
  box.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    acc += e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * term.rows : e.deltaY / 33;
    const n = Math.trunc(acc); if (!n) return;
    acc -= n;
    mirrorScroll(t, (t.sReq || 0) - n);
  }, { capture: true, passive: false });
  const fromY = y => {
    const r = bar.getBoundingClientRect(), total = t.sMax + term.rows;
    const topRow = (y - r.top) / r.height * total - term.rows / 2;
    mirrorScroll(t, t.sMax - topRow);
  };
  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); bar.setPointerCapture(e.pointerId); bar.classList.add('drag');
    fromY(e.clientY);
    const move = ev => fromY(ev.clientY);
    const up = () => { bar.classList.remove('drag'); bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
  });
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (!IS_MAC && e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); }
      return false;
    }
    if (!IS_MAC && e.ctrlKey && k === 'v') return false; // the paste event delivers the text
    return true;
  });
  t.term = term;
  new ResizeObserver(() => fitMirrorFont(t)).observe(box);
  return term;
}
// The mirrored screen keeps the outside window's columns and rows, so scale the font
// both ways: down when it overflows the pane, up until it fills the pane.
const MIRROR_FONT = [8, 24];
function fitMirrorFont(t, again) {
  if (!t.term || !t.el.offsetParent) return;
  const box = t.el.querySelector('.watch-term'), scr = box.querySelector('.xterm-screen');
  if (!scr || !scr.offsetWidth) return;
  const ratio = Math.min((box.clientWidth - 16) / scr.offsetWidth, (box.clientHeight - 8) / scr.offsetHeight);
  const next = Math.max(MIRROR_FONT[0], Math.min(MIRROR_FONT[1], Math.floor(t.fontSize * ratio * 2) / 2));
  if (Math.abs(next - t.fontSize) >= 0.5) {
    t.fontSize = next; t.term.options.fontSize = next;
    // the cell size settles after the next paint; check once more
    if (!again) requestAnimationFrame(() => fitMirrorFont(t, true));
  }
}
function mirrorScroll(t, n) {
  n = Math.max(0, Math.min(t.sMax || 0, Math.round(n)));
  if (n === (t.sReq || 0)) return;
  t.sReq = n;
  if (t.mirror) api.send('mirror:scroll', t.mirror, n);
}
function renderMirrorScroll(t) {
  const box = t.el.querySelector('.watch-term'), bar = box.querySelector('.mscroll'), live = box.querySelector('.mlive');
  if (!bar) return;
  const max = t.sMax || 0, off = t.sOff || 0, rows = t.term.rows, total = max + rows;
  bar.hidden = !max;
  live.hidden = !off;
  if (!max) return;
  const th = bar.firstChild;
  th.style.height = Math.max(6, rows / total * 100) + '%';
  th.style.top = Math.min(100 - rows / total * 100, (max - off) / total * 100) + '%';
}
function onMirrorFrame(t, f) {
  const first = t.mirrorState !== 'live';
  const term = mirrorTerm(t);
  t.sMax = f.max || 0; t.sOff = f.off || 0;
  if ((t.sReq || 0) > t.sMax) t.sReq = t.sMax;
  if (term.cols !== f.cols || term.rows !== f.rows) { term.resize(f.cols, f.rows); requestAnimationFrame(() => fitMirrorFont(t)); }
  term.write('\x1b[?25l\x1b[H' + f.vt + '\x1b[0m\x1b[J' + `\x1b[${f.cy + 1};${f.cx + 1}H` + (f.vis ? '\x1b[?25h' : ''));
  renderMirrorScroll(t);
  if (first) {
    t.mirrorState = 'live';
    renderWatchBar(t);
    if (t.view === 'term' && S.active === t.id) requestAnimationFrame(() => { fitMirrorFont(t); term.focus(); });
  }
}
api.on('mirror:frame', (id, f) => { const t = S.tabs.find(x => x.mirror === id); if (t) onMirrorFrame(t, f); });
api.on('mirror:error', (id, msg) => { const t = S.tabs.find(x => x.mirror === id); if (t) mirrorFailed(t, msg); });
api.on('mirror:exit', id => {
  const t = S.tabs.find(x => x.mirror === id); if (!t) return;
  t.mirror = null;
  t.mirrorState = t.ext ? 'failed' : 'off';
  if (t.term) t.term.write('\x1b[0m\x1b[?25l');
  renderWatchBar(t);
});
function setWatchView(t, v) {
  t.view = v;
  t.el.querySelector('.watch-term').hidden = v !== 'term';
  t.el.querySelector('.watch-log').hidden = v !== 'log';
  renderWatchBar(t);
  requestAnimationFrame(() => {
    if (v === 'term') { fitMirrorFont(t); if (t.term) t.term.focus(); }
    else { const log = t.el.querySelector('.watch-log'); if (t.stick) log.scrollTop = log.scrollHeight; }
  });
}
function renderWatchBar(t) {
  const bar = t.el.querySelector('.watch-bar'); if (!bar) return;
  const s = t.ext;
  const st = s ? (s.status === 'waiting' ? waitText(s.waitingFor) : s.status === 'busy' ? __('Çalışıyor') : __('Hazır')) : '';
  const conn = !s ? __('kapandı') : t.mirrorState === 'live' ? __('terminale bağlı, yazdıkların o pencereye gider') : t.mirrorState === 'connecting' ? __('terminale bağlanılıyor…') : !IS_WIN ? __('Bu sistemde yalnızca konuşma görünür; yazmak için VoxStorm\'a taşı') : __('terminale bağlanılamadı, sadece konuşma görünüyor');
  bar.innerHTML = `<span class="dot ${t.status}"></span>`
    + `<span class="wb-t"><b>${s ? __('VoxStorm dışında açık') : __('Dışarıdaki oturum kapandı')}</b>${st ? ' · ' + esc(st) : ''}`
    + `<small>${esc(s ? s.cwd : t.cwd)}${s ? ' · PID ' + s.pid : ''} · ${esc(conn)}</small></span>`
    + `<span class="seg wb-seg"><button class="${t.view === 'term' ? 'on' : ''}" data-wview="term" ${t.term || t.mirrorState === 'connecting' ? '' : 'disabled'}><i class="fa-solid fa-terminal"></i> ${__('Terminal')}</button><button class="${t.view === 'log' ? 'on' : ''}" data-wview="log"><i class="fa-regular fa-comments"></i> ${__('Konuşma')}</button></span>`
    + (s
      ? `<button class="btn" data-takeover="${t.sessionId}" title="${esc(__('Dışarıdaki claude sürecini kapatır, konuşmaya bir VoxStorm terminalinde kaldığı yerden devam eder'))}"><i class="fa-solid fa-right-to-bracket"></i> ${__('VoxStorm\'a taşı')}</button>`
      : `<button class="btn primary" data-continue="${t.sessionId}" title="${esc(__('Konuşmaya bir VoxStorm terminalinde kaldığı yerden devam eder'))}"><i class="fa-solid fa-play"></i> ${__('VoxStorm\'ta devam et')}</button>`);
}
function watchEntryHTML(e, agent) {
  const tm = e.ts ? new Date(e.ts).toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' }) : '';
  if (e.k === 'user') return `<div class="wm user"><div class="wm-h">${agent ? __('Görev') : __('Sen')}<span>${tm}</span></div><div class="wm-b">${esc(e.text)}</div></div>`;
  if (e.k === 'ai') return `<div class="wm ai"><div class="wm-h">${agent ? __('Ajan') : 'Claude'}<span>${tm}</span></div><div class="wm-b md">${DOMPurify.sanitize(marked.parse(e.text, { gfm: true, breaks: false }))}</div></div>`;
  return `<div class="wm tool" title="${esc(e.name)}: ${esc(e.text)}"><i class="fa-solid fa-wrench"></i><b>${esc(e.name)}</b><span>${esc(e.text)}</span></div>`;
}
async function pollWatch(t) {
  if (t.busy || !S.tabs.includes(t)) return;
  t.busy = true;
  try {
    const isAgent = t.kind === 'agent';
    const r = isAgent
      ? await api.invoke('live:tail', t.parentSid, t.offset, { agentId: t.agentId || '', toolUseId: t.toolUseId || '' })
      : await api.invoke('live:tail', t.sessionId, t.offset);
    if (!r) return;
    if (isAgent && r.agentId) t.agentId = r.agentId;
    const log = t.el.querySelector('.watch-log');
    if (isAgent && r.missing) { // the agent may not have written its first line yet
      if (t.first) { log.innerHTML = `<div class="watch-note empty">${__('Ajanın konuşması bekleniyor…')}</div>`; t.first = false; }
      return;
    }
    if (t.first || r.offset < t.offset) {
      log.innerHTML = r.missing ? `<div class="watch-note">${__('Konuşma kaydı bulunamadı.')}</div>` : r.trimmed ? `<div class="watch-note">${__('Uzun konuşma: son kısmı gösteriliyor.')}</div>` : '';
      t.first = false;
    }
    t.offset = r.offset;
    if (!r.entries.length) {
      if (!log.children.length) log.innerHTML = `<div class="watch-note empty">${__('Henüz mesaj yok.')}</div>`;
      return;
    }
    const empty = log.querySelector('.watch-note.empty'); if (empty) empty.remove();
    log.insertAdjacentHTML('beforeend', r.entries.map(e => watchEntryHTML(e, isAgent)).join(''));
    while (log.children.length > 1500) log.firstElementChild.remove();
    if (t.stick) log.scrollTop = log.scrollHeight;
  } catch (_) {
  } finally { t.busy = false; }
}
async function takeOverSession(sid) {
  const s = S.live.find(x => x.sessionId === sid);
  if (!s) return continueHere(sid);
  const warn = s.status === 'busy' ? '\n\n' + __('DİKKAT: Oturum şu an çalışıyor; yarım kalan iş kesilir.') : '';
  if (!(await uiConfirm({
    title: __("VoxStorm'a taşınsın mı?"), ok: __('Taşı'), danger: s.status === 'busy',
    message: __('"{title}" şu an başka bir terminalde açık (PID {pid}).', { title: shorten(s.title, 60), pid: s.pid }),
    detail: __("VoxStorm'a almak için oradaki claude süreci kapatılacak, konuşma burada kaldığı yerden devam edecek.") + warn,
  }))) return;
  const r = await api.invoke('live:takeover', sid);
  if (!r || !r.ok) { toast(__('Devralınamadı'), (r && r.error) || ''); return; }
  await continueHere(sid, s.cwd);
}
async function continueHere(sid, cwd) {
  const w = watchTab(sid);
  const title = w ? w.title : __('Oturum');
  cwd = cwd || (w && w.cwd);
  S.live = S.live.filter(x => x.sessionId !== sid);
  let p = (w && proj(w.projectId)) || projOfCwd(cwd);
  if (!p && cwd) { const np = await api.invoke('project:addPath', cwd); if (np) { await projectAdded(np); p = proj(np.id); } }
  if (!p) { toast(__('Proje bulunamadı'), cwd || ''); return; }
  if (w) closeTab(w.id);
  await openTerminal({ kind: 'claude', projectId: p.id, resume: sid, title });
}

/* ---------------- rendering: claude mode ---------------- */
const chevron = '<i class="fa-solid fa-chevron-down chev" aria-hidden="true"></i>';
// projects start folded unless they have an open terminal; a click on the header overrides that
const isCollapsed = pid => (pid in S.collapsed ? S.collapsed[pid] : !S.tabs.some(t => t.projectId === pid) && !outsideOf(pid).length);
function renderSide() {
  const activeProjects = S.projects.filter(p => S.tabs.some(t => t.projectId === p.id) || outsideOf(p.id).length);
  const orphans = S.live.filter(s => !projOfCwd(s.cwd));
  const orphanTabs = S.tabs.filter(t => t.kind === 'watch' && !t.projectId && !t.ext);
  if (!activeProjects.length && !orphans.length && !orphanTabs.length) {
    $('#side').innerHTML = `<div class="side-empty"><i class="fa-solid fa-play"></i><b>${__('Açık oturum yok')}</b><span>${__('Üstteki <b>Proje Başlat</b> ile bir proje seç; geçmiş oturumlar da orada.')}</span></div>`;
    if (!$('#startPanel').hidden) renderStartList();
    return;
  }
  $('#side').innerHTML = activeProjects.map(p => {
    const live = S.tabs.filter(t => t.projectId === p.id && t.kind !== 'agent' && !(t.kind === 'watch' && t.ext));
    const ext = outsideOf(p.id);
    const liveIds = new Set([...live.map(t => t.sessionId), ...ext.map(s => s.sessionId)].filter(Boolean));
    const hist = (S.history[p.id] || []).filter(h => !liveIds.has(h.id));
    // only open sessions by default; past ones sit behind "+N oturum daha"
    const limit = S.showAll[p.id] ? hist.length : 0;
    const items = live.map(t => `<li><button class="sess live ${t.id === S.active ? 'active' : ''}${attnCls(t.attn)}" data-tab="${t.id}" title="${esc(t.title)} · ${STATUS_TEXT[t.status]}">${tabIcon(t)}<span class="sess-t">${esc(t.title)}</span><span class="sess-badge ${t.status}">${STATUS_SHORT[t.status]}</span></button></li>`).join('')
      + ext.map(s => extRow(s)).join('')
      + hist.slice(0, limit).map(h => `<li><button class="sess" data-resume="${h.id}" data-pid="${p.id}" title="${esc(h.title)}${h.agent === 'codex' ? ' (Codex)' : ''}&#10;${esc(__('Kaldığı yerden devam ettirmek için tıkla'))}"><span class="dot idle"></span>${h.agent === 'codex' ? CODEX_IC : ''}<span class="sess-t">${esc(h.title)}</span><span class="sess-time">${rel(h.mtime)}</span></button></li>`).join('')
      + (hist.length > limit ? `<li><button class="sess-more" data-more="${p.id}" title="${esc(__('Geçmiş oturumları göster'))}">${__('+ {n} oturum daha', { n: hist.length - limit })}</button></li>`
        : hist.length ? `<li><button class="sess-more" data-more="${p.id}" title="${esc(__('Geçmiş oturumları gizle'))}">${__('Geçmişi gizle')}</button></li>` : '')
      + (!live.length && !ext.length && !hist.length ? `<li class="empty-side" style="padding:4px 8px">${__('Henüz oturum yok')}</li>` : '');
    return `<div class="proj ${isCollapsed(p.id) ? 'collapsed' : ''}">
      <div class="proj-row">
        <button class="proj-toggle" data-toggle="${p.id}">${chevron}<span class="proj-name">${esc(p.name)}</span><span class="proj-path" title="${esc(p.path)}">${esc(p.path)}</span></button>
        <button class="proj-more" data-projmenu="${p.id}" title="${esc(__('Proje seçenekleri'))}" aria-label="${esc(__('Proje seçenekleri'))}"><i class="fa-solid fa-ellipsis"></i></button>
        <span class="split"><button class="new-btn" data-new="${p.id}" title="${esc(__('Bu projede yeni Claude oturumu başlat'))}" aria-label="${esc(__('Yeni Claude oturumu'))}"><i class="fa-solid fa-plus"></i></button><button class="new-btn caret" data-newmenu="${p.id}" title="${esc(__('Terminal ya da PowerShell aç'))}" aria-label="${esc(__('Diğer terminal türleri'))}"><i class="fa-solid fa-caret-down"></i></button></span>
      </div>
      ${syncLineHTML(p)}
      <ul class="sess-list">${items}</ul>
    </div>`;
  }).join('');
  if (orphans.length || orphanTabs.length) {
    $('#side').insertAdjacentHTML('beforeend', `<div class="proj ext-group">
      <div class="proj-row"><span class="proj-toggle" title="${esc(__("VoxStorm'taki projelerin dışındaki klasörlerde açık oturumlar"))}"><i class="fa-solid fa-eye chev" aria-hidden="true"></i><span class="proj-name">${__('Diğer klasörler')}</span></span></div>
      <ul class="sess-list">${orphans.map(s => extRow(s, true)).join('')}${orphanTabs.map(t => `<li><button class="sess live ${t.id === S.active ? 'active' : ''}" data-tab="${t.id}">${tabIcon(t)}<span class="sess-t">${esc(t.title)}</span><span class="sess-badge exited">${__('kapandı')}</span></button></li>`).join('')}</ul>
    </div>`);
  }
}
function extRow(s, showDir) {
  const w = watchTab(s.sessionId), st = LIVE_ST[s.status] || 'idle';
  const tip = `${s.title}\n${s.cwd}\n${__('VoxStorm dışında açık (PID {pid})', { pid: s.pid })} · ${s.status === 'waiting' ? waitText(s.waitingFor) : STATUS_TEXT[st]}\n${__('İzlemek için tıkla')}`;
  const at = w ? w.attn : S.extAttn.get(s.sessionId);
  return `<li><button class="sess live ext ${w && w.id === S.active ? 'active' : ''}${attnCls(at)}" data-watch="${s.sessionId}" title="${esc(tip)}"><span class="dot ${st}"></span><span class="sess-t">${showDir ? `<span class="sess-dir">${esc(baseName(s.cwd))}</span> ` : ''}${esc(s.title)}</span><span class="sess-time ext-tag">${__('dışarıda')}</span></button></li>`;
}
function renderTabs() {
  const tabHTML = t => `<div class="tab ${t.id === S.active ? 'active' : ''}${attnCls(t.attn)}" role="tab"><button data-tab="${t.id}" title="${esc((proj(t.projectId) || {}).name)} · ${esc(t.title)} · ${STATUS_TEXT[t.status]}"><span class="tab-p">${esc((proj(t.projectId) || {}).name || '')}</span>${tabIcon(t)}<span class="tab-t">${esc(t.title)}</span></button><button class="tab-x" data-close="${t.id}" aria-label="${esc(__('Terminali kapat'))}" title="${esc(__('Kapat'))}">×</button></div>`;
  $('#tabs').innerHTML = S.tabs.length
    ? tabStripHTML(tabHTML) + `<button class="tabs-add" data-startnew="1" title="${esc(__('Yeni oturum (Ctrl+Shift+P)'))}" aria-label="${esc(__('Yeni oturum aç'))}"><i class="fa-solid fa-plus"></i></button>` + (window.closedTabs ? closedTabs.buttonHtml() : '')
    : `<span class="tabs-empty">${__('Açık terminal yok')}</span><button class="tabs-add wide" data-startnew="1" title="${esc(__('Bir projede oturum başlat (Ctrl+Shift+P)'))}"><i class="fa-solid fa-plus"></i> ${__('Oturum aç')}</button>` + (window.closedTabs ? closedTabs.buttonHtml(true) : '');
  // IDE bottom panel: only the selected project's terminals
  const pt = S.tabs.filter(t => t.projectId === IDE.project);
  $('#ptabs').innerHTML = pt.map(t => `<button class="ptab ${t.id === S.active ? 'on' : ''}${attnCls(t.attn)}" data-tab="${t.id}" title="${esc(t.title)}">${tabIcon(t)}${esc(t.title)}</button>`).join('')
    + (IDE.project ? `<button class="ptab new" data-new="${IDE.project}"><i class="fa-solid fa-plus"></i> ${__('Oturum')}</button><button class="ptab new caret" data-newmenu="${IDE.project}" title="${esc(__('Terminal ya da PowerShell aç'))}" aria-label="${esc(__('Diğer terminal türleri'))}"><i class="fa-solid fa-caret-down"></i></button>` : '');
  // empty state over the terminal area
  let empty = $('#termEmpty');
  if (!empty) { empty = document.createElement('div'); empty.id = 'termEmpty'; empty.className = 'term-empty'; $('#termHost').appendChild(empty); }
  const visible = tabById(S.active) && (S.mode === 'claude' || tabById(S.active).projectId === IDE.project);
  empty.hidden = !!visible;
  if (!visible) {
    $$('.term-pane').forEach(x => x.classList.remove('on'));
    empty.innerHTML = `<div>${S.projects.length ? __('Açık terminal yok.<br>Sol üstteki <b>Proje Başlat</b> ile bir proje seç ya da <b>Ctrl+Shift+N</b> ile yeni oturum aç.') : __('Başlamak için soldan “+ Proje ekle”.')}</div>`;
  }
}
function renderQueue() {
  $('#qCount').textContent = pendingCount();
  const extCards = extWaiting().map(s => `<div class="card ext">
      <div class="card-top"><span class="chip">${__('Dışarıda')}</span><button class="ghost who" data-watch="${s.sessionId}"><b>${esc(shorten(s.title, 60))}</b> · ${esc((projOfCwd(s.cwd) || {}).name || baseName(s.cwd))}</button></div>
      <div class="card-q">${esc(waitText(s.waitingFor))}</div>
      <div class="card-n">${__('Bu oturum VoxStorm dışında açık; cevabı kendi penceresinden ver ya da oturumu buraya al.')}</div>
      <div class="acts"><button class="btn" data-watch="${s.sessionId}">${__('İzle')}</button><button class="btn" data-takeover="${s.sessionId}">${__("VoxStorm'a al")}</button></div></div>`).join('');
  $('#queue').innerHTML = pendingCount() ? extCards + S.pending.map(d => {
    const t = tabById(d.tabId) || { title: '?' }, p = proj(t.projectId) || {};
    const label = { permission: __('İzin'), plan: __('Plan'), question: __('Soru') }[d.kind];
    let acts;
    const sends = k => esc(__('Terminale {key} gönderir', { key: k }));
    if (d.kind === 'permission' && d.agent === 'codex') acts = `<button class="btn primary" data-dec="${d.id}" data-c="yes" title="${sends('y')}">${__('Evet')}</button><button class="btn" data-dec="${d.id}" data-c="always" title="${esc(__('Terminale p gönderir: bu şekilde başlayan komutlar bir daha sorulmaz'))}">${__('Bu komut için hep')}</button><button class="btn deny" data-dec="${d.id}" data-c="no" title="${sends('Esc')}">${__('Hayır')}</button>`;
    else if (d.kind === 'permission') acts = `<button class="btn primary" data-dec="${d.id}" data-c="yes" title="${sends(1)}">${__('Evet')}</button><button class="btn" data-dec="${d.id}" data-c="always" title="${sends(2)}">${__('Bu oturumda hep')}</button><button class="btn deny" data-dec="${d.id}" data-c="no" title="${sends('Esc')}">${__('Hayır')}</button>`;
    else if (d.kind === 'question' && !d.multi && !d.more && d.options.length) acts = d.options.map((o, i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-dec="${d.id}" data-c="opt${i}" title="${sends(i + 1)}">${esc(o)}</button>`).join('');
    else acts = '';
    acts += `<button class="btn" data-dec="${d.id}" data-c="goto">${__('Terminale git')}</button>`;
    return `<div class="card ${d.kind}">
      <div class="card-top"><span class="chip">${label}</span><button class="ghost who" data-tab="${t.id}"><b>${esc(t.title)}</b> · ${esc(p.name || '')}</button></div>
      <div class="card-q">${esc(d.q)}</div>
      ${d.detail ? `<div class="card-d">${esc(d.detail)}</div>` : ''}
      ${d.kind === 'question' && (d.multi || d.more) ? `<div class="card-d">${d.options.map(esc).join('\n')}</div>` : ''}
      <div class="acts">${acts}</div></div>`;
  }).join('') : `<div class="q-empty">${__('Bekleyen karar yok. Bir oturum izin, plan onayı ya da cevap isteyince burada görünür.')}</div>`;
  const ags = shownAgents();
  $('#agents').innerHTML = ags.length ? ags.map(a => {
    const t = tabById(a.tabId) || {};
    // a Codex subagent's conversation is not in Claude's format: its row leads to the session instead
    const view = a.kind === 'subagent' && a.agent !== 'codex';
    const tip = a.kind === 'term' ? `${__('Arka planda çalışan komut:')}\n${a.name}\n${__('Oturuma gitmek için tıkla')}`
      : view ? `${a.name}${a.type ? ' · ' + a.type : ''}${a.bg ? ' · ' + __('arka planda') : ''}\n${__('Konuşmasını açmak için tıkla')}`
      : `${a.name}${a.type ? ' · ' + a.type : ''}\n${__('Oturuma gitmek için tıkla')}`;
    const label = a.kind === 'subagent' ? __('Ajan') : a.kind === 'term' ? __('Terminal') : 'Workflow';
    const wf = a.kind === 'workflow';
    return `<button class="agent-row" ${view ? `data-agent="${a.id}"` : wf ? `data-wf="${a.id}"` : `data-tab="${a.tabId}"`} title="${esc(wf ? `${a.name}\n${__('Ayrıntıları görmek için tıkla')}` : tip)}"><span class="k ${a.kind}">${label}</span><span class="n">${esc(a.name)}</span><span class="s">${esc(t.title || '')}</span></button>`;
  }).join('') : `<div class="none">${__('Şu an çalışan alt ajan, workflow ya da arka plan komutu yok.')}</div>`;
}
/* The usage view has two modes: tokens counted from the session logs on this machine, or the plan
   limits as Claude Code's /usage shows them (percent of the weekly allowance, when it resets). */
const usageMode = () => ((CFG && CFG.settings.usageMode) === 'plan' ? 'plan' : 'tokens');
// whose usage the view shows: Claude or Codex, one at a time (settings.usageAgent)
const usageAgent = () => ((CFG && CFG.settings.usageAgent) === 'codex' && INFO && INFO.codex ? 'codex' : 'claude');
const PLAN = { data: null, loading: false };
function loadPlan(force) {
  if (PLAN.loading) return;
  PLAN.loading = true;
  api.invoke('usage:plan', !!force)
    .then(d => { PLAN.data = d; }, e => { PLAN.data = { at: Date.now(), error: 'net', message: String(e && e.message || e) }; })
    .finally(() => { PLAN.loading = false; if (usageMode() === 'plan') renderUsage(); });
}
setInterval(() => { if (usageMode() === 'plan') loadPlan(); }, 120000);
function planResetText(iso) {
  if (!iso) return '';
  const t0 = new Date(iso);
  if (isNaN(t0)) return '';
  const t = new Date(Math.floor(t0 / 60000) * 60000), ms = t0 - Date.now(); // 05:59:59.9 reads 05:59, as in Claude Code
  const when = t.toLocaleString(I18N.locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const h = Math.round(ms / 3600000);
  const left = ms <= 0 ? __('şimdi') : h < 1 ? __('{n} dk sonra', { n: Math.max(1, Math.round(ms / 60000)) }) : h < 48 ? __('{n} sa sonra', { n: h }) : __('{n} gün sonra', { n: Math.round(h / 24) });
  return __('{when} sıfırlanır · {left}', { when, left });
}
function renderPlanUsage() {
  const d = PLAN.data, body = $('#usageBody');
  if (!d || Date.now() - d.at > 60000) loadPlan();
  if (!d) { body.innerHTML = `<div class="usage-note">${__('Plan limitleri okunuyor…')}</div>`; return; }
  if (d.error) {
    const msg = { nologin: __("Claude Code'da claude.ai hesabıyla giriş yapılmamış; plan limitleri yalnızca abonelikle görünür."), expired: __("Claude Code'un oturum anahtarının süresi dolmuş. Claude Code'u bir kez açınca yenilenir."), http: __('Plan limitleri okunamadı (HTTP {status}).', { status: d.status }), net: __('Plan limitleri okunamadı: bağlantı kurulamadı.') }[d.error] || __('Plan limitleri okunamadı.');
    body.innerHTML = `<div class="usage-note">${esc(msg)} <button class="ghost" data-planretry="1"><i class="fa-solid fa-rotate-right"></i> ${__('Yenile')}</button></div>`;
    return;
  }
  if (!d.rows.length) { body.innerHTML = `<div class="usage-note">${__('Bu hesapta gösterilecek bir plan limiti yok.')}</div>`; return; }
  body.innerHTML = planRowsHtml(d.rows);
}
function planRowsHtml(rows) {
  return `<div class="plan-rows">${rows.map(r => {
    const p = Math.max(0, Math.min(100, Math.round(r.percent)));
    const lvl = r.severity && r.severity !== 'normal' ? 'hot' : p >= 90 ? 'hot' : p >= 70 ? 'warm' : '';
    return `<div class="plan-row ${lvl}" title="${esc(r.title)}: ${esc(__('%{p} kullanıldı', { p }))}${r.resetsAt ? '\n' + esc(planResetText(r.resetsAt)) : ''}">`
      + `<div class="plan-top"><span class="plan-t">${esc(r.title)}</span><b>${__('%{p} kullanıldı', { p })}</b></div>`
      + `<div class="plan-bar"><i style="width:${p}%"></i></div>`
      + (r.resetsAt ? `<div class="plan-reset">${esc(planResetText(r.resetsAt))}</div>` : '') + '</div>';
  }).join('')}</div>`;
}
/* Codex's limits: what it last reported in its session files (no request is made) */
function renderCodexPlan(cx) {
  const body = $('#usageBody');
  if (!cx) { body.innerHTML = `<div class="usage-note">${__('Hesaplanıyor…')}</div>`; return; }
  const p = cx.plan;
  if (!p || !p.rows.length) { body.innerHTML = `<div class="usage-note">${cx.installed ? __('Codex henüz bir limit bilgisi yazmadı; bir Codex oturumunda ilk yanıttan sonra görünür.') : __('Codex CLI kurulu değil.')}</div>`; return; }
  // rel() gives "5 dk" between a minute and a week ago, "şimdi" or a date otherwise
  const age = Date.now() - p.at, ago = age >= 60000 && age < 7 * 864e5 ? __('{time} önce', { time: rel(p.at) }) : rel(p.at);
  body.innerHTML = planRowsHtml(p.rows)
    + `<div class="usage-note plan-src" title="${esc(__('Codex limitleri her yanıtta oturum dosyasına yazar; VoxStorm en sonuncuyu gösterir. Sıfırlanma saati geçen pencere %0 sayılır.'))}">${p.plan ? __('{plan} planı', { plan: esc(p.plan[0].toUpperCase() + p.plan.slice(1)) }) + ' · ' : ''}${__('son bilgi {when}', { when: esc(ago) })}${p.reached ? ` · <b>${__('limite ulaşıldı')}</b>` : ''}</div>`;
}
function renderUsage() { renderUsageView(); if (typeof dockFit === 'function') dockFit(); } // the dock keeps the group as tall as its content
function renderUsageView() {
  const mb = document.querySelector('[data-usagemode]');
  if (mb) {
    const plan = usageMode() === 'plan';
    mb.classList.toggle('on', plan);
    mb.title = plan ? __('Token görünümüne geç') : usageAgent() === 'codex' ? __('Codex plan limitlerini göster (5 saat / hafta)') : __('Plan limitlerini göster (Claude Code /usage gibi)');
    mb.setAttribute('aria-pressed', String(plan));
  }
  const ag = usageAgent();
  document.querySelectorAll('.usage-ai').forEach(g => { g.hidden = !(INFO && INFO.codex); }); // Codex not installed: no switch
  document.querySelectorAll('[data-usageai]').forEach(b => { const on = b.dataset.usageai === ag; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const cxu = S.usage && S.usage.codex;
  if (usageMode() === 'plan') return ag === 'codex' ? renderCodexPlan(cxu) : renderPlanUsage();
  const u = ag === 'codex' ? cxu : S.usage;
  if (!u) { $('#usageBody').innerHTML = `<div class="usage-note">${__('Hesaplanıyor…')}</div>`; return; }
  const max = Math.max(...u.days, 1), names = [__('Pzt'), __('Sal'), __('Çar'), __('Per'), __('Cum'), __('Cmt'), __('Paz')];
  const dc = u.dayCost || [], money = u.cost != null;
  $('#usageBody').innerHTML = `<div class="days ${ag}">${u.days.map((v, i) => `<div class="day ${i > u.today ? 'future' : ''} ${i === u.today ? 'today' : ''}" title="${esc(names[i])}: ${i > u.today ? esc(__('henüz yok')) : esc(__('{v} token', { v: fmtTok(v) })) + (money ? ' · ≈ ' + fmtUsd(dc[i] || 0) : '')}"><i style="${i > u.today ? '' : `height:${Math.max(3, v / max * 42)}px`}"></i><span>${names[i]}</span></div>`).join('')}</div>`
    + `<div class="usage-stats">${[
      [__('Son 5 saat'), u.last5h ? u.last5h.t : 0, u.last5h ? u.last5h.c : null, __('Son 5 saatte harcanan token ({ai} oturum limitleri 5 saatlik pencereyle sayılır)', { ai: ag === 'codex' ? 'Codex' : 'Claude' })],
      [__('Bugün'), u.days[u.today], dc[u.today] || 0, __('Bugün harcanan token')],
      [__('Bu hafta'), u.total, u.cost, __('Pazartesiden bu yana harcanan token')],
    ].map(([l, t, c, tip]) => `<div class="us" title="${esc(tip)}"><small>${l}</small><b>${fmtTok(t)}</b>${u.cost != null && c != null ? `<span>≈ ${fmtUsd(c)}</span>` : ''}</div>`).join('')}</div>`;
}
function renderStatus() {
  const askBtn = document.querySelector('[data-tb="ask"]');
  document.querySelectorAll('.db-ask').forEach(x => { x.textContent = askLabel(); });
  if (askBtn) { askBtn.querySelector('span').textContent = askLabel(); askBtn.title = aiName() === 'Codex' ? __('Açık dosyayı ya da seçili satırları Codex’e sor') : __('Açık dosyayı ya da seçili satırları Claude’a sor'); }
  const running = S.tabs.filter(t => t.status === 'running' && t.kind !== 'watch' && t.kind !== 'agent').length;
  const claudeOk = INFO && INFO.claude;
  const u = S.usage;
  const usageChip = u ? `<button class="sb-chip" data-report="1" title="${esc(__('Bu hafta · aylık rapor için tıkla (Ctrl+Shift+R)'))}"><i class="fa-solid fa-chart-column"></i> ${__('{v} token', { v: fmtTok(u.total) })}${u.cost != null ? ' · ≈ ' + fmtUsd(u.cost) : ''}</button>` : '';
  $('#statusbar').innerHTML = `<span>${__('<b>{n}</b> çalışıyor', { n: running })}</span><span>${__('<b>{n}</b> karar bekliyor', { n: pendingCount() })}</span>${S.live.length ? `<span title="${esc(__('VoxStorm dışında açık Claude oturumları'))}">${__('<b>{n}</b> dışarıda', { n: S.live.length })}</span>` : ''}<span>${__('<b>{n}</b> ajan / workflow', { n: shownAgents().length })}</span><span>${__('<b>{n}</b> açık terminal', { n: S.tabs.filter(t => !t.exited && t.kind !== 'agent').length })}</span>`
    + (window.pluginHost ? pluginHost.statusHtml() : '') + `<span style="margin-left:auto"></span>${usageChip}`
    + `<button class="sb-chip" data-settab="claude" title="${esc(__('Yeni Claude oturumlarının varsayılanları · değiştirmek için tıkla'))}"><i class="fa-solid fa-sliders"></i> ${esc(claudeSummary())}</button>`
    + `<span class="${claudeOk ? '' : 'warn'}">${claudeOk ? __('Claude Code bağlı') : __('claude komutu bulunamadı')} · ${__('bildirim portu {port}', { port: INFO ? INFO.hookPort : '-' })}</span>`
    + (window.whatsNew ? whatsNew.chipHtml() : '');
  const pb = $('#pillBadge'); pb.hidden = !pendingCount() || S.mode !== 'ide'; pb.textContent = pendingCount();
  const bb = $('#bellBadge'); bb.hidden = !S.unread; bb.textContent = S.unread > 9 ? '9+' : S.unread;
  api.send('tray:update', { running, pending: pendingCount() });
}
function renderPop() {
  $('#nlist').innerHTML = S.notifs.length ? S.notifs.map(n => `<button class="nitem" ${n.tabId ? `data-tab="${n.tabId}"` : ''}><span class="ic ${n.type}">${ICONS[n.type] || 'i'}</span><span class="tx"><b>${esc(n.title)}</b><span>${esc(n.body)}</span></span><span class="tm">${new Date(n.t).toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' })}</span></button>`).join('') : `<div class="n-empty">${__('Henüz bildirim yok.')}</div>`;
}
/* A tab that finished or asks something blinks until it is looked at. */
const attnCls = a => (a ? ` attn attn-${a}` : '');
function trackAttention() {
  const looking = document.hasFocus();
  for (const t of S.tabs) {
    if (t.lastSt === t.status) continue;
    const finished = t.status === 'done' || (t.kind === 'watch' && t.status === 'idle' && (t.lastSt === 'running' || t.lastSt === 'waiting'));
    if (t.lastSt && (finished || t.status === 'waiting') && !(looking && t.id === S.active)) t.attn = t.status === 'waiting' ? 'ask' : 'done';
    else if (t.status === 'running') t.attn = null;
    t.lastSt = t.status;
  }
}
function renderAll() {
  trackAttention();
  renderSide(); renderTabs(); renderQueue(); renderStatus(); renderPanelBadges();
  if (typeof GIT !== 'undefined' && projectHere() !== GIT.btnPid) scheduleGitBtn(true);
  if (S.mode === 'ide') renderIde();
  if (!$('#pop').hidden) renderPop();
  if (window.pluginHost) pluginHost.onRender();
}

/* ---------------- IDE mode ---------------- */
const IDE = {
  project: null, files: {}, dirCache: {}, expanded: {}, cm: null, state: {}, ui: { ex: true, panel: true, size: 13, wrap: false }, mdView: new Set(),
  view: 'files', git: { repo: false, files: {}, dirs: new Set(), branch: '' }, index: {}, watched: null, reveal: null, menu: null,
  search: { q: '', case: false, word: false, regex: false, res: null, busy: false, closed: new Set(), token: 0 },
};
const MODES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'text/typescript', tsx: 'text/typescript-jsx', json: 'application/json',
  css: 'css', scss: 'text/x-scss', less: 'text/x-less', html: 'htmlmixed', htm: 'htmlmixed', xml: 'xml', svg: 'xml', vue: 'htmlmixed',
  md: 'markdown', markdown: 'markdown', py: 'python', go: 'go', rs: 'rust', c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', hpp: 'text/x-c++src', cc: 'text/x-c++src',
  cs: 'text/x-csharp', java: 'text/x-java', kt: 'text/x-kotlin', dart: 'text/x-java', sh: 'shell', bash: 'shell', ps1: 'powershell', psm1: 'powershell',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'toml', dockerfile: 'dockerfile', gd: 'python',
  php: 'application/x-httpd-php', phtml: 'application/x-httpd-php', php3: 'application/x-httpd-php', php4: 'application/x-httpd-php', php5: 'application/x-httpd-php', php7: 'application/x-httpd-php', php8: 'application/x-httpd-php', phps: 'application/x-httpd-php', inc: 'application/x-httpd-php',
};
const LANG_NAMES = {
  javascript: 'JavaScript', jsx: 'JSX', 'text/typescript': 'TypeScript', 'text/typescript-jsx': 'TSX', 'application/json': 'JSON', css: 'CSS', 'text/x-scss': 'SCSS',
  'text/x-less': 'Less', htmlmixed: 'HTML', xml: 'XML', markdown: 'Markdown', python: 'Python', go: 'Go', rust: 'Rust', 'text/x-csrc': 'C', 'text/x-c++src': 'C++',
  'text/x-csharp': 'C#', 'text/x-java': 'Java', 'text/x-kotlin': 'Kotlin', shell: 'Shell', powershell: 'PowerShell', yaml: 'YAML', sql: 'SQL', toml: 'TOML', dockerfile: 'Dockerfile', 'application/x-httpd-php': 'PHP',
};
const extOf = p => { const b = p.split(/[\\/]/).pop().toLowerCase(); return b === 'dockerfile' ? 'dockerfile' : (b.includes('.') ? b.split('.').pop() : ''); };
const baseName = p => p.split(/[\\/]/).pop();
const langName = fp => ({ dart: 'Dart', gd: 'GDScript', svg: 'SVG', vue: 'Vue' })[extOf(fp)] || LANG_NAMES[MODES[extOf(fp)]] || __('Düz metin');
const isImage = fp => /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(fp);
const dirOf = fp => fp.slice(0, Math.max(fp.lastIndexOf('\\'), fp.lastIndexOf('/')));
const joinP = (dir, name) => dir.replace(/[\\/]+$/, '') + SEP + name;
const projRoot = () => { const p = proj(IDE.project); return p ? p.path.replace(/[\\/]+$/, '') : ''; };
const relOf = fp => { const r = projRoot(); return r && normPath(fp).startsWith(normPath(r) + SEP) ? fp.slice(r.length + 1) : fp; };
const under = (fp, base) => { const a = normPath(fp), b = normPath(base); return a === b || a.startsWith(b + SEP); };
const fileUrl = fp => 'file:///' + fp.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map((s, i) => (i === 0 && /^[a-z]:$/i.test(s) ? s : encodeURIComponent(s))).join('/');
const fmtSize = n => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toLocaleString(I18N.locale(), { maximumFractionDigits: 1 }) + ' KB' : (n / 1048576).toLocaleString(I18N.locale(), { maximumFractionDigits: 1 }) + ' MB');
const BAD_NAME = /[<>:"|?*\x00-\x1f]/;
function nameError(v, allowSub) {
  const s = v.trim();
  if (!s) return __('Bir ad yaz.');
  if (BAD_NAME.test(s)) return __('Ad şu karakterleri içeremez: < > : " | ? *');
  if (!allowSub && /[\\/]/.test(s)) return __('Ad \\ ya da / içeremez.');
  if (s.split(/[\\/]/).some(x => x === '..' || x === '.')) return __('"." ve ".." kullanılamaz.');
  if (/[. ]$/.test(s)) return __('Ad nokta ya da boşlukla bitemez.');
  return '';
}
/* file icons (Font Awesome): [icon class, colour] per extension */
const FILE_TYPES = {
  js: ['fa-brands fa-js', '#e5c04a'], mjs: ['fa-brands fa-js', '#e5c04a'], cjs: ['fa-brands fa-js', '#e5c04a'], jsx: ['fa-brands fa-react', '#38bdf8'],
  ts: ['fa-solid fa-file-code', '#4b8fe0'], tsx: ['fa-brands fa-react', '#4b8fe0'], json: ['fa-solid fa-file-code', '#f2b155'],
  md: ['fa-brands fa-markdown', '#a78bfa'], markdown: ['fa-brands fa-markdown', '#a78bfa'],
  css: ['fa-brands fa-css3-alt', '#38bdf8'], scss: ['fa-brands fa-sass', '#e070a8'], sass: ['fa-brands fa-sass', '#e070a8'], less: ['fa-brands fa-less', '#5b8fd0'],
  html: ['fa-brands fa-html5', '#f0884a'], htm: ['fa-brands fa-html5', '#f0884a'], xml: ['fa-solid fa-file-code', '#f0884a'], svg: ['fa-solid fa-file-image', '#f0b44a'],
  vue: ['fa-brands fa-vuejs', '#42b883'], py: ['fa-brands fa-python', '#5a9fd4'], java: ['fa-brands fa-java', '#e07a4f'], go: ['fa-brands fa-golang', '#29beb0'],
  rs: ['fa-brands fa-rust', '#e0855a'], php: ['fa-brands fa-php', '#8892d8'], swift: ['fa-brands fa-swift', '#f07a4a'], dart: ['fa-solid fa-file-code', '#3cb4e6'],
  cs: ['fa-solid fa-hashtag', '#9b7be6'], c: ['fa-solid fa-c', '#6b9be0'], h: ['fa-solid fa-c', '#8a9bb0'], cpp: ['fa-solid fa-file-code', '#6b9be0'],
  kt: ['fa-solid fa-file-code', '#a97bff'], rb: ['fa-solid fa-gem', '#e05555'], gd: ['fa-solid fa-gamepad', '#6aa0d8'],
  sh: ['fa-solid fa-terminal', '#7fc47f'], bash: ['fa-solid fa-terminal', '#7fc47f'], ps1: ['fa-solid fa-terminal', '#5a8fe6'], bat: ['fa-solid fa-terminal', '#9aa3ad'], cmd: ['fa-solid fa-terminal', '#9aa3ad'],
  yml: ['fa-solid fa-sliders', '#e07a8a'], yaml: ['fa-solid fa-sliders', '#e07a8a'], toml: ['fa-solid fa-sliders', '#c6a080'], ini: ['fa-solid fa-sliders', '#9aa3ad'],
  conf: ['fa-solid fa-sliders', '#9aa3ad'], config: ['fa-solid fa-sliders', '#9aa3ad'], env: ['fa-solid fa-key', '#e5c04a'], htaccess: ['fa-solid fa-shield-halved', '#9aa3ad'],
  sql: ['fa-solid fa-database', '#f0a640'], db: ['fa-solid fa-database', '#f0a640'], sqlite: ['fa-solid fa-database', '#f0a640'],
  xlsx: ['fa-solid fa-file-excel', '#3fae6a'], xls: ['fa-solid fa-file-excel', '#3fae6a'], csv: ['fa-solid fa-file-csv', '#3fae6a'],
  docx: ['fa-solid fa-file-word', '#4b84e0'], doc: ['fa-solid fa-file-word', '#4b84e0'], pptx: ['fa-solid fa-file-powerpoint', '#e0703f'], pdf: ['fa-solid fa-file-pdf', '#e05555'],
  png: ['fa-solid fa-file-image', '#3fbfa0'], jpg: ['fa-solid fa-file-image', '#3fbfa0'], jpeg: ['fa-solid fa-file-image', '#3fbfa0'], gif: ['fa-solid fa-file-image', '#3fbfa0'],
  webp: ['fa-solid fa-file-image', '#3fbfa0'], ico: ['fa-solid fa-file-image', '#3fbfa0'], bmp: ['fa-solid fa-file-image', '#3fbfa0'], avif: ['fa-solid fa-file-image', '#3fbfa0'],
  txt: ['fa-solid fa-file-lines', '#9aa3ad'], log: ['fa-solid fa-file-lines', '#9aa3ad'], lock: ['fa-solid fa-lock', '#8a8f98'],
  zip: ['fa-solid fa-file-zipper', '#b8925a'], rar: ['fa-solid fa-file-zipper', '#b8925a'], '7z': ['fa-solid fa-file-zipper', '#b8925a'],
  exe: ['fa-brands fa-windows', '#9aa3ad'], dll: ['fa-solid fa-gears', '#9aa3ad'], dockerfile: ['fa-brands fa-docker', '#3b9ce6'],
  gitignore: ['fa-brands fa-git-alt', '#e0703f'], gitattributes: ['fa-brands fa-git-alt', '#e0703f'], npmrc: ['fa-brands fa-npm', '#e05555'],
};
const SPECIAL_FILES = { 'package.json': ['fa-brands fa-node-js', '#7fc47f'], 'package-lock.json': ['fa-brands fa-npm', '#e05555'], 'claude.md': ['fa-solid fa-robot', '#a78bfa'] };
function fileIcon(name) {
  const b = baseName(name).toLowerCase();
  const ext = b === 'dockerfile' ? 'dockerfile' : b.startsWith('.env') ? 'env' : b.startsWith('.') && !b.slice(1).includes('.') ? b.slice(1) : (b.includes('.') ? b.split('.').pop() : '');
  const [icon, color] = SPECIAL_FILES[b] || FILE_TYPES[ext] || ['fa-regular fa-file', '#8e95a0'];
  return `<i class="fic ${icon}" style="--c:${color}" aria-hidden="true"></i>`;
}
const FOLDER = '<i class="fold fa-solid fa-folder" aria-hidden="true"></i>';
const FOLDER_OPEN = '<i class="fold fa-solid fa-folder-open" aria-hidden="true"></i>';
/* git status letters, as in most editors */
const GIT_TITLE = { M: __('Değiştirildi'), A: __('Eklendi (stage)'), U: __('Yeni, git izlemiyor'), D: __('Silindi'), R: __('Yeniden adlandırıldı'), C: __('Çakışma var') };
const gitOf = fp => IDE.git.files[normPath(fp)] || '';

/* ---------- markdown view ---------- */
const isMarkdown = fp => /\.(md|markdown|mdx)$/i.test(fp);
function resolveRel(fromFile, href) {
  const parts = fromFile.split(/[\\/]/); parts.pop();
  for (const seg of href.split(/[\\/]/)) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join(SEP);
}
function renderMarkdown(fp) {
  const f = IDE.files[fp]; if (!f || !f.doc) return;
  const el = $('#mdView');
  el.innerHTML = DOMPurify.sanitize(marked.parse(f.doc.getValue(), { gfm: true, breaks: false }));
  // local images: make paths relative to the markdown file
  el.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (!/^(https?:|data:|file:)/i.test(src)) img.src = 'file:///' + resolveRel(fp, decodeURI(src)).replace(/\\/g, '/').replace(/^\/+/, '');
  });
  el.dataset.file = fp;
}
/* ---------- image preview ---------- */
function renderImage(fp) {
  const f = IDE.files[fp], el = $('#imgView');
  if (!f) return;
  const v = String(f.mtime || 0);
  if (el.dataset.file === fp && el.dataset.v === v) return;
  el.dataset.file = fp; el.dataset.v = v;
  el.innerHTML = `<div class="iv-stage"><img alt="${esc(baseName(fp))}" src="${esc(fileUrl(fp))}?v=${esc(v)}"></div>`
    + `<div class="iv-info"><b>${esc(baseName(fp))}</b><span class="iv-dim"></span><span>${fmtSize(f.size || 0)}</span></div>`;
  const img = el.querySelector('img');
  img.onload = () => { const d = el.querySelector('.iv-dim'); if (d) d.textContent = __('{w} × {h} piksel', { w: img.naturalWidth, h: img.naturalHeight }); };
  img.onerror = () => { const s = el.querySelector('.iv-stage'); if (s) s.innerHTML = `<div class="iv-err"><i class="fa-regular fa-image"></i>${__('Bu görsel gösterilemedi.')}</div>`; };
}

const ist = () => IDE.state[IDE.project] || (IDE.state[IDE.project] = { tabs: [], file: null });
let ideSaveTimer = null;
function saveIdeState() { clearTimeout(ideSaveTimer); ideSaveTimer = setTimeout(() => api.invoke('config:setIdeState', IDE.state), 400); }
const isDirty = fp => { const f = IDE.files[fp]; return !!f && !!f.doc && (!f.doc.isClean(f.gen) || f.eol !== f.eol0); };
const splitBom = text => (text.charCodeAt(0) === 0xFEFF ? { text: text.slice(1), bom: true } : { text, bom: false });

function setupEditor() {
  IDE.cm = CodeMirror($('#code'), {
    theme: 'claudelot', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true,
    indentUnit: 2, tabSize: 2, value: '', lineWrapping: !!IDE.ui.wrap,
    extraKeys: cmKeys({
      'Ctrl-S': () => saveFile(),
      'Ctrl-F': () => imFind(false),
      Tab: cm => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  ')),
      'Shift-Tab': cm => cm.indentSelection('subtract'),
    }),
  });
  IDE.cm.getWrapperElement().hidden = true;
  IDE.cm.on('changes', () => renderEdChrome());
  IDE.cm.on('cursorActivity', () => renderEdStatus());
}
async function ensureLoaded(fp) {
  if (IDE.files[fp]) return true;
  if (isImage(fp)) {
    let st; try { st = await api.invoke('fs:stat', fp); } catch (e) { st = { exists: false }; }
    if (!st.exists) { toast(__('Dosya açılamadı'), __('{name}: bulunamadı', { name: baseName(fp) })); return false; }
    IDE.files[fp] = { image: true, size: st.size, mtime: st.mtime };
    return true;
  }
  let r;
  try { r = await api.invoke('fs:read', fp); } catch (e) { r = { error: cleanErr(e) }; }
  if (r.error) { toast(__('Dosya açılamadı'), `${baseName(fp)}: ${r.error}`); return false; }
  const { text, bom } = splitBom(r.text);
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const doc = CodeMirror.Doc(text, MODES[extOf(fp)] || null);
  IDE.files[fp] = { doc, gen: doc.changeGeneration(true), eol, eol0: eol, bom };
  return true;
}
/* at: { line (1-based), col, len } — jump there once the file is shown */
async function openFile(fp, at) {
  const pid = IDE.project;
  const ok = await ensureLoaded(fp);
  const s = IDE.state[pid] || (IDE.state[pid] = { tabs: [], file: null });
  imNoteOpened(s, fp, ok);
  if (!ok) {
    s.tabs = s.tabs.filter(x => x !== fp);
    if (s.file === fp) s.file = s.tabs[s.tabs.length - 1] || null;
  } else {
    if (!s.tabs.includes(fp)) s.tabs.push(fp);
    s.file = fp;
  }
  saveIdeState();
  if (pid === IDE.project) { showFile(); if (ok && at) gotoPos(at); }
}
function gotoPos({ line, col = 0, len = 0 }) {
  const fp = ist().file, f = fp && IDE.files[fp];
  if (!f || !f.doc) return;
  if (IDE.mdView.has(fp)) { IDE.mdView.delete(fp); showFile(); }
  const cm = IDE.cm;
  const ln = Math.max(0, Math.min(cm.lineCount() - 1, (line | 0) - 1));
  const from = CodeMirror.Pos(ln, col), to = CodeMirror.Pos(ln, col + len);
  cm.setSelection(from, to);
  requestAnimationFrame(() => { cm.refresh(); cm.scrollIntoView({ from, to }, Math.round(cm.getScrollInfo().clientHeight / 3)); cm.focus(); });
}
function showFile() {
  const fp = ist().file;
  const f = fp && IDE.files[fp];
  if (fp && !f) { openFile(fp); return; }
  const w = IDE.cm.getWrapperElement();
  const md = !!fp && isMarkdown(fp);
  w.classList.toggle('is-md', md);
  $('#imgView').hidden = !(f && f.image);
  if (!f) { w.hidden = true; $('#codeEmpty').hidden = false; $('#mdView').hidden = true; }
  else if (f.image) { w.hidden = true; $('#codeEmpty').hidden = true; $('#mdView').hidden = true; renderImage(fp); }
  else {
    $('#codeEmpty').hidden = true; w.hidden = false;
    if (IDE.cm.getDoc() !== f.doc) IDE.cm.swapDoc(f.doc);
    const mode = MODES[extOf(fp)] || null; // the file may have been renamed to another type
    if (IDE.cm.getOption('mode') !== mode) IDE.cm.setOption('mode', mode);
    requestAnimationFrame(() => IDE.cm.refresh());
    const view = md && IDE.mdView.has(fp);
    $('#mdView').hidden = !view;
    if (view) renderMarkdown(fp);
  }
  renderEdChrome();
  renderTree();
}
/* close several editor tabs, asking once about unsaved work */
async function closeFiles(list) {
  list = list.filter(Boolean);
  if (!list.length) return false;
  const dirty = list.filter(isDirty);
  if (dirty.length && !(await uiConfirm({
    title: __('Kaydedilmemiş değişiklikler'), ok: __('Kaydetmeden kapat'), danger: true,
    message: dirty.length === 1 ? __('{name} dosyasında kaydedilmemiş değişiklikler var.', { name: baseName(dirty[0]) }) : __('{n} dosyada kaydedilmemiş değişiklikler var:\n{names}', { n: dirty.length, names: dirty.map(baseName).join(', ') }),
    detail: __('Yine de kapatılsın mı?'),
  }))) return false;
  const s = ist(), drop = new Set(list);
  imNoteClosed(list);
  const idx = s.tabs.indexOf(s.file);
  s.tabs = s.tabs.filter(x => !drop.has(x));
  if (drop.has(s.file)) s.file = s.tabs[Math.min(Math.max(idx, 0), s.tabs.length - 1)] || null; // the neighbour, not the last tab
  for (const fp of list) if (!Object.values(IDE.state).some(st => st.tabs.includes(fp))) delete IDE.files[fp];
  saveIdeState(); showFile();
  return true;
}
const closeFile = fp => closeFiles([fp]);
async function saveFile(fp) {
  fp = fp || ist().file;
  const f = fp && IDE.files[fp]; if (!f || !f.doc) return false;
  let text = f.doc.getValue();
  if (f.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (f.bom) text = '\uFEFF' + text;
  try { await api.invoke('fs:write', fp, text); } catch (e) { toast(__('Kaydedilemedi'), cleanErr(e)); return false; }
  f.gen = f.doc.changeGeneration(true);
  f.eol0 = f.eol; f.conflict = false; f.missing = false;
  renderEdChrome();
  return true;
}
/* bring an open file up to date with the disk. Unsaved edits are never overwritten
   unless force is set: the file is marked as conflicting and a bar asks what to do. */
async function reloadFromDisk(fp, force) {
  const f = IDE.files[fp]; if (!f) return;
  let st; try { st = await api.invoke('fs:stat', fp); } catch (_) { return; }
  if (!st.exists) { if (!f.missing) { f.missing = true; renderEdChrome(); } return; }
  f.missing = false;
  if (f.image) { f.mtime = st.mtime; f.size = st.size; if (fp === ist().file && S.mode === 'ide') renderImage(fp); return; }
  let r; try { r = await api.invoke('fs:read', fp); } catch (_) { return; }
  if (r.error || !IDE.files[fp]) return;
  const { text, bom } = splitBom(r.text);
  const disk = text.replace(/\r\n/g, '\n');
  if (disk === f.doc.getValue()) { f.conflict = false; return; } // e.g. our own save
  if (isDirty(fp) && !force) { f.conflict = true; renderEdChrome(); return; }
  const cm = IDE.cm, active = cm.getDoc() === f.doc;
  const sels = f.doc.listSelections(), scroll = active ? cm.getScrollInfo() : null;
  f.doc.setValue(disk);
  try { f.doc.setSelections(sels); } catch (_) {}
  if (active) cm.scrollTo(scroll.left, scroll.top);
  f.eol = f.eol0 = /\r\n/.test(text) ? '\r\n' : '\n'; f.bom = bom;
  f.gen = f.doc.changeGeneration(true); f.conflict = false;
  if (fp === ist().file && IDE.mdView.has(fp)) renderMarkdown(fp);
  renderEdChrome();
}
async function fileChangedByClaude(fp, created) {
  const key = normPath(fp);
  S.modified[key] = Date.now();
  if (created) { // a new file may live in a folder we have cached
    const dir = key.slice(0, key.lastIndexOf(SEP));
    Object.keys(IDE.dirCache).forEach(d => { if (normPath(d) === dir) delete IDE.dirCache[d]; });
    delete IDE.index[IDE.project];
  }
  const open = Object.keys(IDE.files).find(k => normPath(k) === key);
  if (open) await reloadFromDisk(open);
  if (S.mode === 'ide') { renderTree(); renderEdChrome(); }
}
/* the folder watcher (main process) reports changes made outside the editor */
const FSQ = { paths: new Set(), git: false, many: false, timer: null };
function onFsChanged(ev) {
  const r = projRoot();
  if (!r || normPath(ev.root) !== normPath(r)) return;
  ev.paths.forEach(p => FSQ.paths.add(p));
  if (ev.git) FSQ.git = true;
  if (ev.many) FSQ.many = true;
  clearTimeout(FSQ.timer); FSQ.timer = setTimeout(applyFsChanges, 120);
}
async function applyFsChanges() {
  const paths = [...FSQ.paths], many = FSQ.many, git = FSQ.git;
  FSQ.paths.clear(); FSQ.many = FSQ.git = false;
  const structural = many || paths.length > 0;
  if (structural) delete IDE.index[IDE.project];
  if (many) IDE.dirCache = {};
  else if (paths.length) {
    const dirs = new Set();
    paths.forEach(p => { const n = normPath(p); dirs.add(n); dirs.add(n.slice(0, n.lastIndexOf(SEP))); });
    Object.keys(IDE.dirCache).forEach(d => { if (dirs.has(normPath(d))) delete IDE.dirCache[d]; });
  }
  const changed = new Set(paths.map(normPath));
  await Promise.all(Object.keys(IDE.files).filter(fp => many || changed.has(normPath(fp))).map(fp => reloadFromDisk(fp)));
  if (git) refreshGit();
  if (S.mode === 'ide' && structural) renderTree();
}
let gitTimer = null;
function refreshGit() {
  clearTimeout(gitTimer);
  gitTimer = setTimeout(async () => {
    const p = proj(IDE.project); if (!p) return;
    let g; try { g = await api.invoke('ide:git', p.path); } catch (_) { g = { repo: false, files: {} }; }
    if (!proj(IDE.project) || proj(IDE.project).path !== p.path) return;
    const root = normPath(p.path).replace(/[\\/]+$/, ''), dirs = new Set();
    for (const [k, c] of Object.entries(g.files)) {
      if (c === 'D') continue;
      let d = k;
      while ((d = d.slice(0, d.lastIndexOf(SEP))).length > root.length) dirs.add(d);
    }
    IDE.git = { repo: g.repo, branch: g.branch || '', files: g.files, dirs };
    if (S.mode === 'ide') { renderTree(); renderEdChrome(); }
  }, 250);
}
function renderEdChrome() {
  if (!IDE.project) { renderEdStatus(); return; }
  const s = ist(), key = s.file;
  const cur = key && IDE.files[key];
  $('#tbSave').disabled = !(key && isDirty(key));
  $('#tbSaveAll').disabled = !s.tabs.some(isDirty);
  // two open files with the same name: show their folder too
  const names = {};
  s.tabs.forEach(k => { const b = baseName(k).toLowerCase(); names[b] = (names[b] || 0) + 1; });
  $('#etabs').innerHTML = s.tabs.length ? s.tabs.map(k => {
    const f = IDE.files[k], d = isDirty(k), g = gitOf(k);
    const dup = names[baseName(k).toLowerCase()] > 1 ? `<span class="et-dir">${esc(baseName(dirOf(k)))}</span>` : '';
    return `<div class="etab ${k === key ? 'on' : ''} ${d ? 'is-dirty' : ''} ${g ? 'g-' + g : ''} ${f && f.missing ? 'is-gone' : ''}" data-etab="${esc(k)}" title="${esc(relOf(k))}${g ? ' · ' + esc(GIT_TITLE[g]) : ''}${d ? ' · ' + esc(__('kaydedilmedi')) : ''}">`
      + `<button data-file="${esc(k)}" role="tab" aria-selected="${k === key}">${fileIcon(k)}<span class="et-n">${esc(baseName(k))}</span>${dup}</button>`
      + `<button class="tab-x" data-fclose="${esc(k)}" aria-label="${esc(__('{name} dosyasını kapat', { name: baseName(k) }))}" title="${esc(__('Kapat (orta tık)'))}"><i class="fa-solid fa-xmark"></i><span class="et-dot" aria-hidden="true"></span></button></div>`;
  }).join('') : `<span class="etabs-empty">${__('Açık dosya yok')}</span>`;
  const on = $('#etabs .etab.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderDiskBar();
  renderEdStatus();
  if (!key) { $('#crumb').innerHTML = ''; $('#crumb').hidden = true; return; }
  $('#crumb').hidden = false;
  const p = proj(IDE.project);
  const relp = relOf(key);
  const dirty = isDirty(key), mod = S.modified[normPath(key)];
  const parts = relp.split(/[\\/]/);
  $('#crumb').innerHTML = `<span class="cr-path"><span class="cr-p">${esc(p ? p.name : '')}</span>${parts.map((x, i) => `<i class="fa-solid fa-chevron-right cr-sep" aria-hidden="true"></i><span class="${i === parts.length - 1 ? 'cr-f' : 'cr-p'}">${esc(x)}</span>`).join('')}</span>`
    + (mod ? `<span class="crumb-mod" title="${esc(__('Claude bu dosyayı düzenledi'))}"><i class="fa-solid fa-robot"></i> ${__('Claude değiştirdi · {time}', { time: rel(mod) })}</span>` : '')
    + (isMarkdown(key) ? `<span class="seg md-seg"><button class="${IDE.mdView.has(key) ? '' : 'on'}" data-mdmode="src" title="${esc(__('Markdown kaynağını düzenle'))}"><i class="fa-solid fa-code"></i> ${__('Yazı')}</button><button class="${IDE.mdView.has(key) ? 'on' : ''}" data-mdmode="view" title="${esc(__('Biçimlendirilmiş görünüm'))}"><i class="fa-solid fa-eye"></i> ${__('Görünüm')}</button></span>` : '')
    + (cur && cur.image ? '' : `<span class="save-wrap"><span class="sv-st ${dirty ? 'is-dirty' : ''}">${dirty ? __('Kaydedilmedi') : __('Kaydedildi')}</span><button class="btn ${dirty ? 'primary' : ''}" id="saveBtn" ${dirty ? '' : 'disabled'}>${__('Kaydet')} <kbd>Ctrl+S</kbd></button></span>`);
}
/* a bar above the editor when the file changed on disk under unsaved edits, or disappeared */
function renderDiskBar() {
  const fp = ist().file, f = fp && IDE.files[fp], el = $('#diskBar');
  if (!f || (!f.conflict && !f.missing)) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'disk-bar ' + (f.missing ? 'gone' : 'conflict');
  el.innerHTML = f.missing
    ? `<i class="fa-solid fa-triangle-exclamation"></i><span>${__('Bu dosya diskte yok: silinmiş ya da taşınmış.')}</span>`
      + (f.doc ? `<button class="btn" data-ixdisk="save">${__('Kaydet ve yeniden oluştur')}</button>` : '') + `<button class="btn" data-ixdisk="close">${__('Sekmeyi kapat')}</button>`
    : `<i class="fa-solid fa-code-compare"></i><span>${__('Dosya diskte değişti (ör. Claude düzenledi), ama sende kaydedilmemiş değişiklikler var.')}</span>`
      + `<button class="btn primary" data-ixdisk="load">${__('Diskteki sürümü yükle')}</button><button class="btn" data-ixdisk="keep">${__('Benimkini koru')}</button>`;
}
/* editor status strip: cursor, indentation, encoding, line endings, language, wrap */
function renderEdStatus() {
  const el = $('#edStatus'); if (!el) return;
  const fp = IDE.project && ist().file, f = fp && IDE.files[fp];
  if (!f) { el.hidden = true; return; }
  el.hidden = false;
  const g = gitOf(fp);
  const left = (IDE.git.repo && IDE.git.branch ? `<span class="es-i" title="${esc(__('Git dalı'))}"><i class="fa-solid fa-code-branch"></i>${esc(IDE.git.branch)}</span>` : '')
    + (g ? `<span class="es-i es-g g-${g}" title="${esc(__('Git durumu'))}">${GIT_TITLE[g]}</span>` : '');
  if (f.image) { el.innerHTML = left + `<span class="es-sp"></span><span class="es-i">${__('Görsel önizleme')}</span>`; return; }
  const cm = IDE.cm, c = cm.getCursor();
  const selLen = cm.getSelections().reduce((a, s) => a + s.length, 0);
  el.innerHTML = left + '<span class="es-sp"></span>'
    + `<button class="es-i" data-ixes="goto" title="${esc(__('Satıra git (Ctrl+G)'))}">${__('Satır {line}, Sütun {col}', { line: c.line + 1, col: c.ch + 1 })}${selLen ? ` <span class="es-m">${__('({n} seçili)', { n: selLen })}</span>` : ''}</button>`
    + `<span class="es-i" title="${esc(__('Girinti'))}">${__('Boşluk: {n}', { n: cm.getOption('indentUnit') })}</span>`
    + `<span class="es-i" title="${esc(__('Karakter kodlaması'))}">${f.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>`
    + `<button class="es-i" data-ixes="eol" title="${esc(__('Satır sonu: tıklayınca {eol} olur (kaydedince uygulanır)', { eol: f.eol === '\r\n' ? 'LF' : 'CRLF' }))}">${f.eol === '\r\n' ? 'CRLF' : 'LF'}</button>`
    + `<span class="es-i" title="${esc(__('Dil'))}">${esc(langName(fp))}</span>`
    + `<button class="es-i" data-ixes="wrap" aria-pressed="${!!IDE.ui.wrap}" title="${esc(__('Satır sarmayı aç / kapat (Alt+Z)'))}"><i class="fa-solid fa-arrow-turn-down"></i>${IDE.ui.wrap ? __('Sarma açık') : __('Sarma kapalı')}</button>`;
}
async function loadDir(dir) {
  if (IDE.dirCache[dir]) return IDE.dirCache[dir];
  try { IDE.dirCache[dir] = await api.invoke('fs:list', dir); } catch (_) { IDE.dirCache[dir] = []; }
  return IDE.dirCache[dir];
}
let treeToken = 0;
async function renderTree() {
  const p = proj(IDE.project);
  if (!p) { $('#tree').innerHTML = `<div class="ex-empty"><i class="fa-regular fa-folder-open"></i><b>${__('Proje yok')}</b><span>${__('Claude modunda “Proje ekle” ile bir klasör ekle.')}</span></div>`; return; }
  if (IDE.watched !== p.path) { // follow the project shown in the IDE
    IDE.watched = p.path;
    api.invoke('ide:watch', p.path).catch(() => {});
    IDE.git = { repo: false, files: {}, dirs: new Set(), branch: '' };
    refreshGit();
  }
  const my = ++treeToken;
  await loadDir(p.path);
  const loadOpen = async dir => { for (const e of IDE.dirCache[dir] || []) if (e.dir && IDE.expanded[e.path]) { await loadDir(e.path); await loadOpen(e.path); } };
  await loadOpen(p.path);
  if (my !== treeToken) return;
  const cur = ist().file;
  const walk = (dir, d) => (IDE.dirCache[dir] || []).map(e => {
    if (e.dir) {
      const open = IDE.expanded[e.path], gd = IDE.git.dirs.has(normPath(e.path));
      return `<button draggable="true" class="fx dir ${open ? '' : 'closed'} ${gd ? 'g-dir' : ''}" style="--d:${d}" data-dir="${esc(e.path)}" aria-expanded="${!!open}" title="${esc(e.name)}${gd ? ' · ' + esc(__('içinde değişiklik var')) : ''}"><i class="car fa-solid fa-chevron-down" aria-hidden="true"></i>${open ? FOLDER_OPEN : FOLDER}<span class="fn">${esc(e.name)}</span>${gd ? '<span class="gdot" aria-hidden="true"></span>' : ''}</button>` + (open ? walk(e.path, d + 1) : '');
    }
    const g = gitOf(e.path), m = S.modified[normPath(e.path)];
    const mk = IDE.mark && IDE.mark.fp === normPath(e.path) && Date.now() < IDE.mark.until;
    return `<button draggable="true" class="fx file ${mk ? 'agent-mark' : ''} ${e.path === cur ? 'on' : ''} ${/^(~\$|\.)/.test(e.name) ? 'dim' : ''} ${g ? 'g-' + g : ''}" style="--d:${d}" data-file="${esc(e.path)}" title="${esc(e.name)}${g ? ' · ' + esc(GIT_TITLE[g]) : ''}${m ? ' · ' + esc(__('Claude değiştirdi')) : ''}">${fileIcon(e.name)}<span class="fn">${esc(e.name)}</span>${mk ? `<span class="amark"><i class="fa-solid fa-robot"></i>${esc(IDE.mark.by)}</span>` : ''}${m ? `<span class="mod" aria-label="${esc(__('Claude değiştirdi'))}"><i class="fa-solid fa-robot"></i></span>` : ''}${g ? `<span class="gb">${g}</span>` : ''}</button>`;
  }).join('');
  const html = walk(p.path, 0);
  const tree = $('#tree');
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#tree .fx');
  const keep = focused ? (focused.dataset.file || focused.dataset.dir) : null, top = tree.scrollTop;
  tree.innerHTML = html || `<div class="ex-empty"><i class="fa-regular fa-folder"></i><b>${__('Klasör boş')}</b><span>${__('Sağ tıkla ya da yukarıdaki düğmelerle dosya ekle.')}</span></div>`;
  tree.scrollTop = top;
  const find = fp => $$('#tree .fx').find(b => (b.dataset.file || b.dataset.dir) === fp);
  if (keep) { const b = find(keep); if (b) b.focus({ preventScroll: true }); }
  if (IDE.reveal) { const b = find(IDE.reveal); IDE.reveal = null; if (b) b.scrollIntoView({ block: 'center' }); }
}
/* open the folders on the way to a file and scroll it into view; `by` (an agent's name) marks it
   for a few seconds: the row blinks with a "Claude" badge (show_file of agentlink.js) */
let markTimer = null;
function revealInTree(fp, by) {
  const r = projRoot(); if (!r || !under(fp, r)) return;
  if (by) {
    IDE.mark = { fp: normPath(fp), by, until: Date.now() + 6000 };
    clearTimeout(markTimer);
    markTimer = setTimeout(() => {
      IDE.mark = null;
      $$('#tree .agent-mark').forEach(b => { b.classList.remove('agent-mark'); const a = b.querySelector('.amark'); if (a) a.remove(); });
    }, 6000);
  }
  let d = dirOf(fp);
  while (d.length > r.length) { IDE.expanded[d] = true; d = dirOf(d); }
  if (IDE.view !== 'files') setExView('files');
  IDE.reveal = fp;
  renderTree();
}
function renderIde() {
  if (!IDE.project || !proj(IDE.project)) IDE.project = S.projects[0] ? S.projects[0].id : null;
  // project picker (dropdown); rebuilt only when its contents change so an open list isn't closed
  const opts = S.projects.map(p => {
    const n = S.tabs.filter(t => t.projectId === p.id && (t.status === 'running' || t.status === 'waiting')).length;
    return `<option value="${p.id}">${esc(p.name)}${n ? ' · ' + __('{n} aktif', { n }) : ''}</option>`;
  }).join('') || `<option value="">${__('Proje yok')}</option>`;
  const sel = $('#ideProjSel');
  if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
  sel.value = IDE.project || '';
  const cur = proj(IDE.project);
  $('#ideProjPath').textContent = cur ? cur.path : '';
  $('#ideProjPath').title = cur ? cur.path : '';
  renderEdChrome();
}
function switchIdeProject(pid) {
  if (pid === IDE.project) return;
  IDE.project = pid;
  IDE.search.res = null; renderSearch();
  const live = S.tabs.filter(t => t.projectId === pid);
  if (!live.some(t => t.id === S.active)) S.active = live.length ? live[live.length - 1].id : null;
  showFile();
  renderAll();
  const t = tabById(S.active);
  if (t) { $$('.term-pane').forEach(x => x.classList.toggle('on', x === t.el)); requestAnimationFrame(fitActive); }
}
function applyIdeUi() {
  $('#ideView').classList.toggle('no-ex', !IDE.ui.ex);
  const bp = $('#bpanel'), right = IDE.ui.dock === 'right';
  bp.hidden = !IDE.ui.panel;
  // docked right: the panel becomes its own grid column next to the editor
  if (right && bp.parentElement !== $('#ideView')) $('.editor').after(bp);
  else if (!right && bp.parentElement !== $('.editor')) $('.editor').appendChild(bp);
  $('#ideView').classList.toggle('dock-r', right && IDE.ui.panel);
  $('#ideView').style.setProperty('--pw', IDE.ui.pw + 'px');
  bp.style.setProperty('--ph', IDE.ui.ph + 'px');
  const dk = $('#bpDock'), tip = right ? __('Paneli alta al') : __('Paneli sağa al');
  dk.title = tip; dk.setAttribute('aria-label', tip);
  dk.innerHTML = right ? '<i class="fa-solid fa-table-columns fa-rotate-270"></i>' : '<i class="fa-solid fa-table-columns"></i>';
  $('#code').style.setProperty('--ed-size', IDE.ui.size + 'px');
  $('#tbEx').setAttribute('aria-pressed', IDE.ui.ex);
  $('#tbPanel').setAttribute('aria-pressed', IDE.ui.panel);
  $('#tbSize').textContent = IDE.ui.size + 'px';
  IDE.cm.setOption('lineWrapping', !!IDE.ui.wrap);
  renderEdStatus();
  requestAnimationFrame(() => { IDE.cm.refresh(); fitActive(); });
}
function saveIdeUi() { applyIdeUi(); setCfg({ ide: { ui: IDE.ui } }); }
function toggleWrap() { IDE.ui.wrap = !IDE.ui.wrap; saveIdeUi(); }
/* puts "@path" (and the selected lines) into the project's session of the default AI (Claude or Codex) */
async function askClaude(target, targetIsDir) {
  const p = proj(IDE.project);
  const fp = target || ist().file;
  if (!fp || !p) { toast(__('Önce bir dosya aç')); return; }
  const isDir = !!targetIsDir;
  let ref = '@' + relOf(fp).replace(/\\/g, '/') + (isDir ? '/' : '');
  const cm = IDE.cm, f = IDE.files[fp];
  if (fp === ist().file && f && f.doc && cm.somethingSelected()) {
    const a = cm.getCursor('from').line + 1, b = cm.getCursor('to').line + 1;
    ref += ' ' + (a === b ? __('(satır {a})', { a }) : __('(satır {a}-{b})', { a, b }));
  }
  IDE.ui.panel = true; saveIdeUi();
  let t = tabById(S.active);
  const want = defaultAgent(), mine = x => x && x.kind === 'claude' && !x.exited && x.projectId === p.id && (x.agent || 'claude') === want;
  if (!mine(t)) t = [...S.tabs].reverse().find(mine);
  let delay = 0;
  if (!t) { t = await openTerminal({ kind: 'claude', projectId: p.id }); delay = 2500; }
  if (!t) return;
  activate(t.id);
  setTimeout(() => { if (!t.exited) api.send('pty:write', t.id, ref + ' '); t.term.focus(); }, delay);
}

/* ---------- explorer: files / search views ---------- */
function setExView(v) {
  IDE.view = v;
  $('[data-exview]').forEach(b => { b.classList.toggle('on', b.dataset.exview === v); b.setAttribute('aria-selected', b.dataset.exview === v); });
  $('#tree').hidden = v !== 'files';
  $('#psearch').hidden = v !== 'search';
  $('#exFileActs').hidden = v !== 'files';
  if (window.ideDb) ideDb.showSide(v === 'db');
  if (v === 'search') { renderSearch(); requestAnimationFrame(() => { $('#psIn').focus(); $('#psIn').select(); }); }
}
function openProjectSearch() {
  if (!IDE.ui.ex) { IDE.ui.ex = true; saveIdeUi(); }
  const cm = IDE.cm, f = IDE.files[ist().file];
  const sel = f && f.doc && !cm.getWrapperElement().hidden && cm.somethingSelected() ? cm.getSelection() : '';
  if (sel && !sel.includes('\n') && sel.length < 200) { $('#psIn').value = sel; IDE.search.q = ''; }
  setExView('search');
  if (sel) runSearch();
}
let searchTimer = null;
async function runSearch() {
  clearTimeout(searchTimer);
  const S2 = IDE.search, q = $('#psIn').value, p = proj(IDE.project);
  if (!p) return;
  if (!q.trim()) { S2.q = ''; S2.res = null; renderSearch(); return; }
  const sig = [q, S2.case, S2.word, S2.regex, p.id].join('\u0001');
  if (sig === S2.q && S2.res && !S2.res.stale) return;
  S2.q = sig; S2.busy = true; S2.closed = new Set();
  const my = ++S2.token;
  renderSearch();
  let r; try { r = await api.invoke('ide:search', p.path, q, { case: S2.case, word: S2.word, regex: S2.regex }); } catch (e) { r = { error: cleanErr(e) }; }
  if (my !== S2.token) return;
  S2.busy = false;
  S2.res = { ...r, pid: p.id, root: p.path.replace(/[\\/]+$/, ''), q };
  renderSearch();
}
function renderSearch() {
  const S2 = IDE.search, sum = $('#psSum'), box = $('#psRes');
  $$('[data-psopt]').forEach(b => b.setAttribute('aria-pressed', !!S2[b.dataset.psopt]));
  const res = S2.res && S2.res.pid === IDE.project ? S2.res : null;
  if (S2.busy) { sum.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${__('Aranıyor…')}`; return; }
  if (!res) { sum.textContent = ''; box.innerHTML = `<div class="ex-empty"><i class="fa-solid fa-magnifying-glass"></i><b>${__('Projede ara')}</b><span>${__('Yaz ve Enter’a bas. Sonuca tıklayınca dosya o satırda açılır.')}</span></div>`; return; }
  if (res.error) { sum.innerHTML = `<span class="ps-err">${esc(res.error)}</span>`; box.innerHTML = ''; return; }
  if (!res.hits.length) { sum.textContent = __('Sonuç bulunamadı.'); box.innerHTML = ''; return; }
  sum.textContent = res.truncated ? __('{files} dosyada {n}+ sonuç (ilk 2000 gösteriliyor)', { files: res.files, n: res.hits.length }) : __('{files} dosyada {n} sonuç', { files: res.files, n: res.hits.length });
  const groups = new Map();
  res.hits.forEach((h, i) => { if (!groups.has(h.file)) groups.set(h.file, []); groups.get(h.file).push(i); });
  let html = '';
  for (const [file, idx] of groups) {
    const shut = S2.closed.has(file), dir = dirOf(file);
    html += `<button class="ps-f ${shut ? 'closed' : ''}" data-psfile="${esc(file)}" aria-expanded="${!shut}" title="${esc(file)}"><i class="car fa-solid fa-chevron-down" aria-hidden="true"></i>${fileIcon(file)}<span class="fn">${esc(baseName(file))}</span><span class="ps-dir">${esc(dir)}</span><span class="ps-n">${idx.length}</span></button>`;
    if (shut) continue;
    html += idx.map(i => {
      const h = res.hits[i], a = h.col - h.pre, t = h.text;
      // the panel is narrow: keep only a little text before the match so the match stays visible
      let before = t.slice(0, a).replace(/^\s+/, '');
      const cut = h.pre > 0 || before.length > 18;
      if (before.length > 18) before = before.slice(-18);
      return `<button class="ps-h" data-pshit="${i}" title="${esc(__('Satır {line}', { line: h.line }))}: ${esc(t.trim())}"><span class="ps-ln">${h.line}</span><span class="ps-t">${cut ? '…' : ''}${esc(before)}<mark>${esc(t.slice(a, a + h.len))}</mark>${esc(t.slice(a + h.len))}</span></button>`;
    }).join('');
  }
  box.innerHTML = html;
}

/* ---------- quick open (Ctrl+P), go to line (Ctrl+G) and name prompts ---------- */
const QO = { mode: 'file', items: [], sel: 0, resolve: null, validate: null };
async function fileIndex() {
  const p = proj(IDE.project); if (!p) return null;
  if (IDE.index[p.id]) return IDE.index[p.id];
  try { IDE.index[p.id] = await api.invoke('ide:files', p.path); } catch (_) { IDE.index[p.id] = { files: [], complete: true }; }
  return IDE.index[p.id];
}
/* subsequence match; rewards word starts, runs and hits in the file name */
function fuzzy(q, path) {
  const t = path.toLowerCase(), base = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')) + 1;
  const tryFrom = start => {
    let qi = 0, score = 0, last = -2;
    const pos = [];
    for (let i = start; i < t.length && qi < q.length; i++) {
      if (t[i] !== q[qi]) continue;
      let sc = 1;
      if (i === last + 1) sc += 4;
      if (i === base || /[\\/._\-\s]/.test(t[i - 1] || '\\')) sc += 3;
      if (i >= base) sc += 2;
      score += sc; pos.push(i); last = i; qi++;
    }
    return qi === q.length ? { score, pos } : null;
  };
  // prefer a match that stays inside the file name
  const r = tryFrom(base) || tryFrom(0);
  if (!r) return null;
  if (t.slice(base).startsWith(q)) r.score += 12;
  r.score -= t.length * 0.05;
  return r;
}
const markPos = (s, pos, off) => { let out = ''; for (let i = 0; i < s.length; i++) out += pos.has(i + off) ? `<b>${esc(s[i])}</b>` : esc(s[i]); return out; };
function openPalette(text) {
  if (S.mode !== 'ide') setMode('ide');
  if (!proj(IDE.project)) { toast(__('Önce bir proje ekle')); return; }
  QO.mode = 'file'; QO.resolve = null; QO.validate = null;
  $('#qoBg').hidden = false;
  $('#qoTitle').hidden = true;
  const inp = $('#qoIn');
  inp.value = text || ''; inp.placeholder = __('Dosya adı yaz · satıra gitmek için : yaz');
  inp.setAttribute('aria-label', __('Dosyaya git'));
  inp.focus();
  if (text === ':') inp.setSelectionRange(1, 1);
  QO.sel = 0;
  renderPalette();
  fileIndex().then(() => { if (!$('#qoBg').hidden && QO.mode === 'file') renderPalette(); });
}
/* a small dialog for a name; resolves to the text, or null when cancelled */
function askName({ title, hint, value = '', select, placeholder = '', validate }) {
  if (QO.resolve) QO.resolve(null);
  return new Promise(resolve => {
    QO.mode = 'prompt'; QO.resolve = resolve; QO.validate = validate || null; QO.hint = hint || '';
    $('#qoBg').hidden = false;
    $('#qoTitle').hidden = false; $('#qoTitle').textContent = title;
    const inp = $('#qoIn');
    inp.value = value; inp.placeholder = placeholder; inp.setAttribute('aria-label', title);
    inp.focus();
    if (select) inp.setSelectionRange(select[0], select[1]); else inp.select();
    renderPalette();
  });
}
function closePalette(result) {
  if ($('#qoBg').hidden) return;
  $('#qoBg').hidden = true;
  const r = QO.resolve; QO.resolve = null;
  if (r) r(result == null ? null : result);
  if (!IDE.cm.getWrapperElement().hidden && result === undefined) IDE.cm.focus();
}
function renderPalette() {
  const v = $('#qoIn').value, list = $('#qoList'), foot = $('#qoFoot');
  if (QO.mode === 'prompt') {
    const err = QO.validate ? QO.validate(v) : '';
    QO.items = [];
    list.innerHTML = `<div class="qo-note ${err && v ? 'err' : ''}">${esc(err && v ? err : QO.hint)}</div>`;
    foot.innerHTML = `<span>${__('<kbd>Enter</kbd> onayla')}</span><span>${__('<kbd>Esc</kbd> vazgeç')}</span>`;
    return;
  }
  foot.innerHTML = `<span>${__('<kbd>↑</kbd><kbd>↓</kbd> seç')}</span><span>${__('<kbd>Enter</kbd> aç')}</span><span>${__('<kbd>:</kbd>12 satıra git')}</span><span>${__('<kbd>Esc</kbd> kapat')}</span>`;
  const m = v.match(/^(.*?):(\d*)$/);
  const q = (m ? m[1] : v).trim(), line = m ? +m[2] || 0 : 0;
  const cur = ist().file, f = cur && IDE.files[cur];
  if (m && !q) { // ":42" — a line in the open file
    QO.items = f && f.doc ? [{ line: line || 1 }] : [];
    list.innerHTML = f && f.doc
      ? `<button class="qo-row sel" data-qoi="0"><i class="fa-solid fa-arrow-right-to-bracket qo-ic"></i><span class="qo-n">${line ? __('Satır {line}’e git', { line }) : __('Bir satır numarası yaz')}</span><span class="qo-d">${esc(baseName(cur))} · 1–${IDE.cm.lineCount()}</span></button>`
      : `<div class="qo-note">${__('Satıra gitmek için önce bir metin dosyası aç.')}</div>`;
    QO.sel = 0;
    return;
  }
  const idx = IDE.index[IDE.project];
  if (!idx) { QO.items = []; list.innerHTML = `<div class="qo-note"><i class="fa-solid fa-spinner fa-spin"></i> ${__('Dosyalar taranıyor…')}</div>`; return; }
  const root = projRoot();
  let items;
  if (!q) {
    // nothing typed: open tabs first (most recent last → first), then the rest
    const open = [...ist().tabs].reverse().filter(x => x !== cur).map(x => relOf(x));
    const seen = new Set(open.map(x => x.toLowerCase()));
    items = [...open, ...idx.files.filter(x => !seen.has(x.toLowerCase()))].slice(0, 60).map(rel => ({ rel, pos: new Set(), open: seen.has(rel.toLowerCase()) }));
  } else {
    const ql = q.toLowerCase().replace(/[\\/]/g, SEP).replace(/\s+/g, '');
    const scored = [];
    for (const rel of idx.files) { const r = fuzzy(ql, rel); if (r) scored.push({ rel, score: r.score, pos: new Set(r.pos) }); }
    scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
    items = scored.slice(0, 60);
  }
  QO.items = items.map(it => ({ ...it, full: joinP(root, it.rel), line }));
  QO.sel = Math.min(QO.sel, Math.max(0, QO.items.length - 1));
  list.innerHTML = QO.items.length ? QO.items.map((it, i) => {
    const b = Math.max(it.rel.lastIndexOf('\\'), it.rel.lastIndexOf('/')) + 1, name = it.rel.slice(b), dir = it.rel.slice(0, Math.max(0, b - 1));
    const g = gitOf(it.full);
    return `<button class="qo-row ${i === QO.sel ? 'sel' : ''} ${g ? 'g-' + g : ''}" data-qoi="${i}" role="option" aria-selected="${i === QO.sel}">${fileIcon(name)}<span class="qo-n">${markPos(name, it.pos, b)}</span><span class="qo-d">${markPos(dir, it.pos, 0)}</span>${it.open ? `<span class="qo-tag">${__('açık')}</span>` : ''}</button>`;
  }).join('') + (idx.complete ? '' : `<div class="qo-note">${__('Proje çok büyük; yalnızca ilk 20.000 dosya tarandı.')}</div>`)
    : `<div class="qo-note">${__('“{q}” ile eşleşen dosya yok.', { q: esc(q) })}</div>`;
  const s = list.querySelector('.qo-row.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
}
function pickPalette(i) {
  if (QO.mode === 'prompt') {
    const v = $('#qoIn').value;
    if (QO.validate && QO.validate(v)) { renderPalette(); return; }
    closePalette(v.trim());
    return;
  }
  const it = QO.items[i == null ? QO.sel : i]; if (!it) return;
  closePalette(null);
  if (!it.rel) { gotoPos({ line: it.line }); return; }
  openFile(it.full, it.line ? { line: it.line } : null).then(() => { revealInTree(it.full); if (!it.line && !IDE.cm.getWrapperElement().hidden) IDE.cm.focus(); });
}

/* ---------- file operations from the tree ---------- */
async function newEntry(dir, isDir) {
  const r = projRoot(); if (!r) { toast(__('Önce bir proje ekle')); return; }
  dir = dir && under(dir, r) ? dir : r;
  const where = normPath(dir) === normPath(r) ? __('proje kökü') : relOf(dir);
  const name = await askName({
    title: isDir ? __('Yeni klasör') : __('Yeni dosya'),
    hint: __('Konum: {where} · alt klasör için / kullanabilirsin', { where }),
    placeholder: isDir ? __('klasör-adı') : __('dosya-adı.js'),
    validate: v => nameError(v, true),
  });
  if (!name) return;
  const clean = name.replace(/[\\/]/g, SEP).replace(/^[\\/]+|[\\/]+$/g, '');
  const full = joinP(dir, clean);
  let st = { exists: false }; try { st = await api.invoke('fs:stat', full); } catch (_) {}
  if (st.exists && (isDir || st.dir)) { toast(__('Zaten var'), st.dir ? __('{name} adında bir klasör var.', { name: clean }) : __('{name} adında bir dosya var.', { name: clean })); return; }
  if (!st.exists) {
    try { await api.invoke(isDir ? 'fs:mkdir' : 'fs:create', full); } catch (e) { toast(isDir ? __('Klasör oluşturulamadı') : __('Dosya oluşturulamadı'), cleanErr(e)); return; }
  }
  IDE.dirCache = {}; delete IDE.index[IDE.project];
  IDE.expanded[dir] = true;
  if (isDir) { IDE.expanded[full] = true; revealInTree(full); }
  else { await openFile(full); revealInTree(full); }
}
function remapPaths(from, to) {
  const swap = k => (under(k, from) ? to + k.slice(from.length) : k);
  const files = {};
  for (const [k, f] of Object.entries(IDE.files)) files[swap(k)] = f;
  IDE.files = files;
  for (const st of Object.values(IDE.state)) { st.tabs = st.tabs.map(swap); if (st.file) st.file = swap(st.file); }
  IDE.mdView = new Set([...IDE.mdView].map(swap));
  const exp = {}; for (const [k, v] of Object.entries(IDE.expanded)) exp[swap(k)] = v; IDE.expanded = exp;
  const fromN = normPath(from), toN = normPath(to);
  for (const k of Object.keys(S.modified)) if (k === fromN || k.startsWith(fromN + SEP)) { S.modified[toN + k.slice(fromN.length)] = S.modified[k]; delete S.modified[k]; }
  saveIdeState();
}
async function renameEntry(fp, isDir) {
  if (normPath(fp) === normPath(projRoot())) return;
  const old = baseName(fp), dot = old.lastIndexOf('.');
  const name = await askName({
    title: isDir ? __('Klasörü yeniden adlandır') : __('Dosyayı yeniden adlandır'),
    hint: __('Şu anki ad: {name}', { name: old }), value: old, select: [0, !isDir && dot > 0 ? dot : old.length],
    validate: v => nameError(v, false),
  });
  if (!name || name === old) return;
  const to = joinP(dirOf(fp), name);
  try { await api.invoke('fs:rename', fp, to); } catch (e) { toast(__('Yeniden adlandırılamadı'), cleanErr(e)); return; }
  remapPaths(fp, to);
  IDE.dirCache = {}; delete IDE.index[IDE.project];
  IDE.reveal = to;
  showFile();
}
async function deleteEntry(fp, isDir) {
  if (normPath(fp) === normPath(projRoot())) return;
  const open = Object.keys(IDE.files).filter(k => under(k, fp));
  const dirty = open.filter(isDirty);
  const msg = (isDir ? __('“{name}” klasörü ve içindekiler Geri Dönüşüm Kutusu’na taşınsın mı?', { name: baseName(fp) }) : __('“{name}” dosyası Geri Dönüşüm Kutusu’na taşınsın mı?', { name: baseName(fp) }))
    + (dirty.length ? '\n\n' + __('Kaydedilmemiş değişiklikler kaybolacak: {names}', { names: dirty.map(baseName).join(', ') }) : '');
  if (!(await uiConfirm({ title: __('Silinsin mi?'), message: msg, ok: __('Geri Dönüşüm Kutusu’na taşı'), danger: true, icon: 'fa-trash-can' }))) return;
  try { await api.invoke('fs:trash', fp); } catch (e) { toast(__('Silinemedi'), cleanErr(e)); return; }
  for (const st of Object.values(IDE.state)) {
    const idx = st.tabs.indexOf(st.file);
    st.tabs = st.tabs.filter(k => !under(k, fp));
    if (st.file && under(st.file, fp)) st.file = st.tabs[Math.min(Math.max(idx, 0), st.tabs.length - 1)] || null;
  }
  open.forEach(k => { delete IDE.files[k]; IDE.mdView.delete(k); });
  IDE.dirCache = {}; delete IDE.index[IDE.project];
  saveIdeState(); showFile();
  toast(__('Geri Dönüşüm Kutusu’na taşındı'), baseName(fp));
}
function copyText(text, what) {
  navigator.clipboard.writeText(text).then(() => toast(what, text), () => toast(__('Kopyalanamadı')));
}

/* ---------- context menus (tree and editor tabs) ---------- */
function openIdeMenu(e, ctx) {
  e.preventDefault();
  IDE.menu = ctx;
  const m = $('#ideMenu');
  const it = (act, icon, label, key, cls = '') => `<button data-ixm="${act}" class="${cls}" role="menuitem"><span class="mi"><i class="mic ${icon}"></i>${label}</span>${key ? `<code>${key}</code>` : ''}</button>`;
  const sep = '<div class="sep"></div>';
  let html = '';
  if (ctx.kind === 'dock') html = dockMenuHtml(ctx, it, sep);
  else if (ctx.kind === 'tab') {
    const s = ist(), i = s.tabs.indexOf(ctx.path);
    html = it('close', 'fa-solid fa-xmark', __('Kapat'), 'Ctrl+W')
      + (s.tabs.length > 1 ? it('closeothers', 'fa-solid fa-clone', __('Diğerlerini kapat')) : '')
      + (i < s.tabs.length - 1 ? it('closeright', 'fa-solid fa-arrow-right-long', __('Sağdakileri kapat')) : '')
      + (s.tabs.some(k => !isDirty(k)) ? it('closesaved', 'fa-solid fa-check-double', __('Kaydedilmişleri kapat')) : '')
      + it('closeall', 'fa-solid fa-square-xmark', __('Tümünü kapat'))
      + sep + it('revealtree', 'fa-solid fa-folder-tree', __('Dosya ağacında göster'))
      + it('copy', 'fa-regular fa-copy', __('Yolu kopyala')) + it('copyrel', 'fa-solid fa-link', __('Göreli yolu kopyala'))
      + it('reveal', 'fa-regular fa-folder-open', __('Dosya Gezgini’nde göster'));
  } else {
    const root = !ctx.path || normPath(ctx.path) === normPath(projRoot());
    html = it('newfile', 'fa-solid fa-file-circle-plus', __('Yeni dosya')) + it('newdir', 'fa-solid fa-folder-plus', __('Yeni klasör'))
      + (root ? sep + it('collapse', 'fa-solid fa-angles-up', __('Tümünü daralt')) + it('refresh', 'fa-solid fa-arrows-rotate', __('Yenile'))
        : sep + it('rename', 'fa-solid fa-i-cursor', __('Yeniden adlandır'), 'F2') + it('delete', 'fa-regular fa-trash-can', __('Sil'), 'Delete', 'danger'))
      + sep + it('copy', 'fa-regular fa-copy', __('Yolu kopyala')) + (root ? '' : it('copyrel', 'fa-solid fa-link', __('Göreli yolu kopyala')))
      + it('reveal', 'fa-regular fa-folder-open', __('Dosya Gezgini’nde göster'))
      + (root ? '' : sep + it('ask', 'fa-solid fa-comment-dots', askLabel(), '', 'accent'));
  }
  // items plugins added to the file menu (tree and editor tabs)
  if (ctx.kind !== 'dock' && window.pluginHost) {
    const fp = ctx.path || projRoot();
    if (fp) html += pluginHost.menuHtml('file', { kind: ctx.kind === 'tab' || !ctx.dir ? 'file' : 'dir', path: fp, projectId: IDE.project || null, from: ctx.kind === 'tab' ? 'tab' : 'tree' });
  }
  m.innerHTML = html;
  m.hidden = false;
  const w = $('#win').getBoundingClientRect();
  const left = Math.min(e.clientX - w.left, w.width - m.offsetWidth - 8), top = Math.min(e.clientY - w.top, w.height - m.offsetHeight - 8);
  m.style.left = Math.max(8, left) + 'px'; m.style.top = Math.max(44, top) + 'px';
  // keyboard users get the first item with Down; the menu itself takes focus so Esc works
  m.tabIndex = -1; m.focus();
}
function closeIdeMenu() { $('#ideMenu').hidden = true; }
function ideMenuAction(act) {
  const ctx = IDE.menu; closeIdeMenu();
  if (!ctx) return;
  if (ctx.kind === 'dock') return dockMenuAction(act, ctx);
  const r = projRoot(), fp = ctx.path || r, isDir = ctx.kind === 'tree' && (!ctx.path || ctx.dir);
  const s = ist();
  if (act === 'close') closeFile(fp);
  else if (act === 'closeothers') closeFiles(s.tabs.filter(k => k !== fp));
  else if (act === 'closeright') closeFiles(s.tabs.slice(s.tabs.indexOf(fp) + 1));
  else if (act === 'closesaved') closeFiles(s.tabs.filter(k => !isDirty(k)));
  else if (act === 'closeall') closeFiles([...s.tabs]);
  else if (act === 'revealtree') { if (!IDE.ui.ex) { IDE.ui.ex = true; saveIdeUi(); } revealInTree(fp); }
  else if (act === 'copy') copyText(fp, __('Yol kopyalandı'));
  else if (act === 'copyrel') copyText(relOf(fp), __('Göreli yol kopyalandı'));
  else if (act === 'reveal') api.invoke('fs:reveal', fp).catch(e => toast(__('Açılamadı'), cleanErr(e)));
  else if (act === 'newfile' || act === 'newdir') newEntry(isDir ? fp : dirOf(fp), act === 'newdir');
  else if (act === 'rename') renameEntry(fp, isDir);
  else if (act === 'delete') deleteEntry(fp, isDir);
  else if (act === 'collapse') { IDE.expanded = {}; renderTree(); }
  else if (act === 'refresh') { IDE.dirCache = {}; delete IDE.index[IDE.project]; renderTree(); refreshGit(); }
  else if (act === 'ask') askClaude(fp, isDir);
}
/* shortcuts that belong to the IDE: only in IDE mode and not while typing in a terminal */
const ideKeysOk = e => S.mode === 'ide' && !(e.target.closest && e.target.closest('.xterm')) && $('#settings').hidden && $('#report').hidden && $('#discover').hidden && $('#wfWin').hidden;

function bindIde() {
  api.on('ide:fs-changed', onFsChanged);
  // drag the panel edge: height when docked at the bottom, width when docked right
  const grip = $('#bpGrip');
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const right = IDE.ui.dock === 'right', bp = $('#bpanel'), view = $('#ideView');
    const start = right ? e.clientX : e.clientY, from = right ? bp.offsetWidth : bp.offsetHeight;
    const max = right ? view.clientWidth - 320 : $('.editor').clientHeight - 120;
    grip.setPointerCapture(e.pointerId); grip.classList.add('drag'); view.classList.add('dragging');
    const move = ev => {
      const v = Math.round(Math.max(right ? 260 : 120, Math.min(max, from + start - (right ? ev.clientX : ev.clientY))));
      if (right) { IDE.ui.pw = v; view.style.setProperty('--pw', v + 'px'); } else { IDE.ui.ph = v; bp.style.setProperty('--ph', v + 'px'); }
    };
    const up = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      grip.classList.remove('drag'); view.classList.remove('dragging');
      saveIdeUi();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => { if (IDE.ui.dock === 'right') IDE.ui.pw = 440; else IDE.ui.ph = 260; saveIdeUi(); });
  $('#refreshTree').onclick = () => { IDE.dirCache = {}; delete IDE.index[IDE.project]; renderTree(); refreshGit(); };
  $('#exNewFile').onclick = () => newEntry(projRoot(), false);
  $('#exNewDir').onclick = () => newEntry(projRoot(), true);
  $('#exCollapse').onclick = () => { IDE.expanded = {}; renderTree(); };
  $$('[data-exview]').forEach(b => b.addEventListener('click', () => setExView(b.dataset.exview)));
  // tree: right click, F2, Delete, arrow keys
  $('#tree').addEventListener('contextmenu', e => {
    const b = e.target.closest('.fx');
    openIdeMenu(e, b ? { kind: 'tree', path: b.dataset.file || b.dataset.dir, dir: !!b.dataset.dir } : { kind: 'tree', path: null, dir: true });
  });
  $('#tree').addEventListener('keydown', e => {
    const b = e.target.closest('.fx'); if (!b) return;
    const p = b.dataset.file || b.dataset.dir, isDir = !!b.dataset.dir;
    const move = d => { const all = $$('#tree .fx'); const n = all[all.indexOf(b) + d]; if (n) n.focus(); };
    if (e.key === 'F2') { e.preventDefault(); renameEntry(p, isDir); }
    else if (e.key === 'Delete') { e.preventDefault(); deleteEntry(p, isDir); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'ArrowRight' && isDir) { e.preventDefault(); if (!IDE.expanded[p]) { IDE.expanded[p] = true; renderTree(); } else move(1); }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isDir && IDE.expanded[p]) { IDE.expanded[p] = false; renderTree(); }
      else { const parent = $$('#tree .fx.dir').find(x => x.dataset.dir === dirOf(p)); if (parent) parent.focus(); }
    }
  });
  // editor tabs: middle click closes, right click opens the tab menu
  // middle click closes a terminal tab, like a browser
  for (const id of ['#tabs', '#ptabs']) {
    $(id).addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }); // no autoscroll cursor
    $(id).addEventListener('auxclick', e => {
      const b = e.target.closest('[data-tab]');
      if (b && e.button === 1) { e.preventDefault(); closeTab(b.dataset.tab); }
    });
  }
  $('#etabs').addEventListener('auxclick', e => { const t = e.target.closest('[data-etab]'); if (t && e.button === 1) { e.preventDefault(); closeFile(t.dataset.etab); } });
  $('#etabs').addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }); // no autoscroll cursor
  $('#etabs').addEventListener('contextmenu', e => { const t = e.target.closest('[data-etab]'); if (t) openIdeMenu(e, { kind: 'tab', path: t.dataset.etab }); });
  // tab strips scroll sideways with the plain mouse wheel, no Shift needed
  for (const id of ['#etabs', '#tabs', '#ptabs']) {
    const strip = $(id);
    strip.addEventListener('wheel', e => { if (e.deltaY && !e.deltaX && !e.shiftKey) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  }
  $('#ideMenu').addEventListener('click', e => { const b = e.target.closest('[data-ixm]'); if (b) ideMenuAction(b.dataset.ixm); });
  $('#ideMenu').addEventListener('keydown', e => {
    const all = $$('#ideMenu button'), i = all.indexOf(document.activeElement); // -1 while the menu itself has focus
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = i < 0 ? all[e.key === 'ArrowDown' ? 0 : all.length - 1] : all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]; if (n) n.focus(); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeIdeMenu(); }
  });
  document.addEventListener('mousedown', e => { if (!$('#ideMenu').hidden && !e.target.closest('#ideMenu')) closeIdeMenu(); }, true);
  window.addEventListener('blur', closeIdeMenu);
  // disk bar, status strip
  $('#diskBar').addEventListener('click', async e => {
    const b = e.target.closest('[data-ixdisk]'); if (!b) return;
    const fp = ist().file, f = IDE.files[fp]; if (!f) return;
    const a = b.dataset.ixdisk;
    if (a === 'load') await reloadFromDisk(fp, true);
    else if (a === 'keep') { f.conflict = false; renderEdChrome(); }
    else if (a === 'save') { if (await saveFile(fp)) { IDE.dirCache = {}; renderTree(); } }
    else if (a === 'close') closeFile(fp);
  });
  $('#edStatus').addEventListener('click', e => {
    const b = e.target.closest('[data-ixes]'); if (!b) return;
    const a = b.dataset.ixes, f = IDE.files[ist().file];
    if (a === 'goto') openPalette(':');
    else if (a === 'wrap') toggleWrap();
    else if (a === 'eol' && f && f.doc) { f.eol = f.eol === '\r\n' ? '\n' : '\r\n'; renderEdChrome(); }
  });
  // project search
  $('#psIn').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); IDE.search.q = ''; runSearch(); }
    else if (e.key === 'Escape') { e.stopPropagation(); if (!IDE.cm.getWrapperElement().hidden) IDE.cm.focus(); }
  });
  $('#psIn').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if ($('#psIn').value.trim().length >= 2 || !$('#psIn').value.trim()) runSearch(); }, 450); });
  $$('[data-psopt]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.psopt; IDE.search[k] = !IDE.search[k]; IDE.search.q = ''; renderSearch(); runSearch(); }));
  $('#psRes').addEventListener('click', e => {
    const f = e.target.closest('[data-psfile]');
    if (f) { const k = f.dataset.psfile; if (IDE.search.closed.has(k)) IDE.search.closed.delete(k); else IDE.search.closed.add(k); renderSearch(); return; }
    const h = e.target.closest('[data-pshit]'); if (!h) return;
    const res = IDE.search.res, hit = res && res.hits[+h.dataset.pshit]; if (!hit) return;
    $$('#psRes .ps-h.on').forEach(x => x.classList.remove('on')); h.classList.add('on');
    openFile(joinP(res.root, hit.file), { line: hit.line, col: hit.col, len: hit.len });
  });
  // quick open / prompt
  $('#qoIn').addEventListener('input', () => { QO.sel = 0; renderPalette(); });
  $('#qoIn').addEventListener('keydown', e => {
    const n = QO.items.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); QO.sel = (QO.sel + 1) % n; renderPalette(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); QO.sel = (QO.sel - 1 + n) % n; renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); pickPalette(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
  });
  $('#qoList').addEventListener('click', e => { const b = e.target.closest('[data-qoi]'); if (b) pickPalette(+b.dataset.qoi); });
  $('#qoBg').addEventListener('mousedown', e => { if (e.target.id === 'qoBg') closePalette(); });
}

/* ---------------- mode ---------------- */
function setMode(m, initial) {
  // a mode in another window: go to that window (at start-up, show a mode that is here instead)
  if (ONLY ? m !== ONLY : DETACHED.has(m)) {
    if (!initial) { api.send('win:focusMode', m); return; }
    m = ONLY || firstAttached();
  }
  if (String(m).startsWith('plugin:') && !(window.pluginHost && pluginHost.hasMode(m))) m = 'claude';
  if (!ONLY && DETACHED.has(m)) m = firstAttached();
  S.mode = m;
  $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#claudeView').hidden = m !== 'claude';
  $('#ideView').hidden = m !== 'ide';
  $('#dbView').hidden = m !== 'db';
  $('#sshView').hidden = m !== 'ssh';
  if (window.pluginHost) pluginHost.onMode(m);
  const host = $('#termHost');
  (m === 'ide' ? $('#ideSlot') : $('#centerSlot')).appendChild(host);
  if (m === 'ide') {
    const t = tabById(S.active);
    if (t) IDE.project = t.projectId;
    if (!IDE.project || !proj(IDE.project)) IDE.project = S.projects[0] ? S.projects[0].id : null;
    if (!S.tabs.some(x => x.id === S.active && x.projectId === IDE.project)) {
      const live = S.tabs.filter(x => x.projectId === IDE.project);
      S.active = live.length ? live[live.length - 1].id : null;
    }
    applyIdeUi();
    showFile();
  } else if (!tabById(S.active) && S.tabs.length) S.active = S.tabs[S.tabs.length - 1].id;
  const t = tabById(S.active);
  $$('.term-pane').forEach(x => x.classList.toggle('on', !!t && x === t.el));
  if (!initial && !ONLY) setCfg({ settings: { mode: m } });
  renderAll();
  requestAnimationFrame(() => { fitActive(); if (m === 'ide') IDE.cm.refresh(); });
  // DB mode lives in db.js; it exposes window.dbMode = { show, hide }
  if (window.dbMode) { if (m === 'db') window.dbMode.show(); else window.dbMode.hide(); }
  if (window.sshMode) { if (m === 'ssh') window.sshMode.show(); else window.sshMode.hide(); }
}

/* ---------------- detached mode windows ----------------
   Any mode of the pill (AI, IDE, DB, a plugin's mode) can move to a window of its own, e.g. DB on a
   second monitor. That window loads this page as index.html?only=<mode> and shows just that mode;
   in the main window its pill button stays, marked, and takes you to the other window. Closing the
   window brings the mode back. Terminals live where AI mode is: they move with it (see main.js). */
const ONLY = new URLSearchParams(location.search).get('only') || '';
let DETACHED = new Set(); // modes in a window of their own (main window only)
const ownsAI = () => (ONLY ? ONLY === 'claude' : !DETACHED.has('claude'));
const pillModes = () => $$('.mode-pill [data-mode]').map(b => b.dataset.mode);
const firstAttached = () => pillModes().find(m => !DETACHED.has(m)) || 'claude';
// the main window keeps at least one mode
const canDetach = m => !ONLY && !DETACHED.has(m) && pillModes().filter(x => !DETACHED.has(x)).length > 1;
async function detachMode(m) {
  if (!canDetach(m)) { if (!ONLY) toast(__('Ayrı pencereye alınamaz'), __('Ana pencerede en az bir mod kalmalı.')); return; }
  if (m === 'ide' && Object.keys(IDE.files).some(isDirty)) {
    uiAlert({ title: __('Kaydedilmemiş dosyalar var'), message: __('IDE’yi ayrı pencereye almadan önce açık dosyaları kaydet.') });
    return;
  }
  await api.invoke('win:detach', m);
}
function toggleDetach() { if (ONLY) api.invoke('win:attach', ONLY); else detachMode(S.mode); }
function renderDetached() {
  let st = document.getElementById('detachStyle');
  if (!st) { st = document.createElement('style'); st.id = 'detachStyle'; document.head.appendChild(st); }
  const sel = m => `.mode-pill [data-mode="${CSS.escape(m)}"]`;
  st.textContent = ONLY ? `.mode-pill [data-mode]:not(${sel(ONLY)}){display:none}`
    : [...DETACHED].map(m => `${sel(m)}{opacity:.6}${sel(m)}::after{content:"\\2197";font-size:10px;margin-left:-2px}`).join('');
  $$('.mode-pill [data-mode]').forEach(b => {
    if (b.dataset.t0 == null) b.dataset.t0 = b.title;
    b.title = b.dataset.t0 + ' · ' + (ONLY ? __('sağ tık: ana pencereye geri al')
      : DETACHED.has(b.dataset.mode) ? __('ayrı pencerede (tıkla: o pencereye geç · sağ tık: geri al)') : __('sağ tık: ayrı pencerede aç'));
  });
}
function onDetached(list) {
  if (ONLY) return;
  const had = ownsAI();
  DETACHED = new Set(list || []);
  renderDetached();
  if (DETACHED.has(S.mode)) setMode(firstAttached());
  if (had !== ownsAI()) {
    if (had) setLive([]);
    else api.invoke('live:list').then(setLive).catch(() => {});
  }
}
// main.js asks for this when the window closes or AI mode moves away: let go of every terminal
// (the processes keep running) and say what they were, so another window can take them
window.vsReleaseTabs = () => {
  const out = [];
  for (const t of S.tabs) {
    if (t.kind === 'watch') { clearInterval(t.timer); if (t.mirror) api.send('mirror:stop', t.mirror); out.push({ kind: 'watch', sessionId: t.sessionId }); }
    else if (t.kind === 'agent') clearInterval(t.timer);
    else if (!t.exited && !String(t.id).startsWith('pending-')) {
      out.push({ id: t.id, kind: t.kind, agent: t.agent || null, shell: t.shell || null, projectId: t.projectId, sessionId: t.sessionId, title: t.title, renamed: !!t.renamed, prompted: !!t.prompted, status: t.status, active: t.id === S.active });
    }
    if (t.term) t.term.dispose();
    t.el.remove();
  }
  S.tabs = []; S.active = null; S.pending = []; S.agents = [];
  saveOpenTabs();
  renderAll();
  return out;
};
// a detached window is closing: unsaved files in its IDE?
window.vsCanClose = async () => {
  if (!Object.keys(IDE.files).some(isDirty)) return true;
  return uiConfirm({ title: __('Kaydedilmemiş dosyalar var'), message: __('Pencere kapanırsa kaydedilmemiş değişiklikler kaybolur.'), ok: __('Kaydetmeden kapat'), danger: true });
};
function adoptTerminal(tab, a) {
  tab.id = a.id; tab.sessionId = a.sessionId || null;
  tab.prompted = !!a.prompted; tab.renamed = !!a.renamed;
  if (STATUS_TEXT[a.status]) tab.status = a.status;
  if (a.buffer) tab.term.write(a.buffer);
  (early.get(a.id) || []).forEach(d => tab.term.write(d));
  early.delete(a.id);
  if (a.exited) {
    tab.exited = true; tab.status = 'exited';
    tab.term.write(`\r\n\x1b[90m${a.code ? __('[İşlem sona erdi · çıkış kodu {code}. Sekmeyi kapatabilirsin.]', { code: a.code }) : __('[İşlem sona erdi. Sekmeyi kapatabilirsin.]')}\x1b[0m\r\n`);
    return;
  }
  // the program redraws when its size changes; the replayed output alone may be cut off at the top
  setTimeout(() => {
    if (tab.exited) return;
    const { cols, rows } = tab.term;
    api.send('pty:resize', tab.id, Math.max(20, cols - 1), rows);
    setTimeout(() => { if (!tab.exited) api.send('pty:resize', tab.id, tab.term.cols, tab.term.rows); }, 120);
  }, 200);
}
async function adoptTabs() {
  let list = [];
  try { list = await api.invoke('win:takeTabs'); } catch (_) {}
  if (!Array.isArray(list) || !list.length) return;
  if (ownsAI()) { try { setLive(await api.invoke('live:list')); } catch (_) {} }
  let act = null, n = 0;
  for (const it of list) {
    if (it.kind === 'watch') { if (isExtLive(it.sessionId)) { openWatch(it.sessionId); n++; } continue; }
    if (!proj(it.projectId)) { api.send('pty:kill', it.id); continue; }
    const t = await openTerminal({ kind: it.kind, agent: it.agent || 'claude', shell: it.shell || undefined, projectId: it.projectId, title: it.title, adopt: it });
    if (t) { n++; if (it.active) act = t.id; }
  }
  if (act) activate(act);
  saveOpenTabs();
  if (n) toast(__('Terminaller bu pencereye taşındı'), __('{n} terminal', { n }));
}
async function winInit() {
  if (ONLY) {
    document.documentElement.dataset.only = ONLY;
    if (ONLY.startsWith('plugin:')) CFG.settings.mode = ONLY; // plugins.js opens it once the plugin has loaded
    const b = document.createElement('button');
    b.className = 'tb-btn'; b.id = 'attachBtn';
    b.title = __('Ana pencereye geri al (Ctrl+Shift+M)'); b.setAttribute('aria-label', __('Ana pencereye geri al'));
    b.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i>';
    b.onclick = () => api.invoke('win:attach', ONLY);
    $('.tb-right').prepend(b);
    $('#closeBtn').title = __('Kapat (mod ana pencereye geri döner)');
  } else {
    try { DETACHED = new Set(await api.invoke('win:detached')); } catch (_) {}
    if (!ownsAI()) setLive([]);
  }
  renderDetached();
  // plugin mode buttons are added later and re-made on every change
  new MutationObserver(() => renderDetached()).observe($('.mode-pill'), { childList: true });
  api.on('win:detached', onDetached);
  api.on('win:set-mode', m => { if (!ONLY) setMode(m); });
  api.on('win:tabs', adoptTabs);
  $('.mode-pill').addEventListener('contextmenu', e => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    e.preventDefault();
    api.send('win:modeMenu', b.dataset.mode, canDetach(b.dataset.mode));
  });
}

/* ---------------- menus ---------------- */
function placeMenu(m, btn) {
  const w = $('#win').getBoundingClientRect(), r = btn.getBoundingClientRect();
  m.hidden = false;
  const left = Math.max(8, Math.min(r.right - w.left - m.offsetWidth, w.width - m.offsetWidth - 8));
  let top = r.bottom - w.top + 4;
  if (top + m.offsetHeight > w.height - 8) top = r.top - w.top - m.offsetHeight - 4;
  m.style.left = left + 'px'; m.style.top = Math.max(44, top) + 'px';
}
function openNewMenu(btn, pid, withHistory) {
  const m = $('#newMenu');
  m.innerHTML = `<button data-newkind="claude" data-pid="${pid}"><span class="mi"><i class="mic fa-solid fa-terminal"></i>${__('Claude oturumu')}</span><code class="ell" title="${esc(claudeSummary())}">${esc(claudeSummary())}</code></button>`
    + `<div class="has-sub"><button class="sub-open" type="button"><span class="mi"><i class="mic fa-solid fa-user-shield"></i>${__('İzin moduyla başlat')}</span><i class="fa-solid fa-chevron-right sub-ar"></i></button>`
    + `<div class="sub">${QUICK_MODES.map(([k, l]) => `<button data-newkind="claude" data-pm="${k}" data-pid="${pid}" class="${k === 'bypassPermissions' ? 'danger' : ''}"><span>${l}</span><code>${k}</code></button>`).join('')}</div></div>`
    + (INFO.codex ? `<button data-newkind="codex" data-pid="${pid}" title="${esc(__('OpenAI Codex CLI oturumu (Ctrl+Shift+X)'))}"><span class="mi"><i class="mic fa-brands fa-openai"></i>${__('Codex oturumu')}</span><code class="ell" title="${esc(codexSummary())}">${esc(codexSummary())}</code></button>` : '')
    + `<div class="sep"></div>`
    + Object.keys(SHELLS).map(k => `<button data-newkind="${k}" data-pid="${pid}"><span class="mi">${SHELL_ICONS[k]}${SHELLS[k].name}</span><code>${SHELLS[k].exe}</code></button>`).join('');
  if (withHistory) {
    const hist = (S.history[pid] || []).slice(0, 6);
    const nRestore = (CFG.lastTabs || []).filter(t => t.projectId === pid).length;
    m.innerHTML += `<div class="sep"></div><div class="lbl">${__('Geçmiş')}</div>`
      + (nRestore ? `<button data-pact="restore" data-pid="${pid}"><span class="mi"><i class="mic fa-solid fa-clock-rotate-left"></i>${__('Son oturumları geri yükle')}</span><code>${nRestore}</code></button>` : '')
      + (hist.length ? hist.map(h => `<button data-resume="${h.id}" data-pid="${pid}" title="${esc(h.title)}${h.agent === 'codex' ? ' (Codex)' : ''}"><span class="mi hist"><i class="mic ${h.agent === 'codex' ? 'fa-brands fa-openai' : 'fa-regular fa-comment'}"></i><span>${esc(shorten(h.title, 34))}</span></span><code>${rel(h.mtime)}</code></button>`).join('') : `<div class="lbl" style="text-transform:none;letter-spacing:0;font-weight:400">${__('Geçmiş oturum yok')}</div>`);
  }
  m.querySelector('.sub-open').addEventListener('click', ev => { ev.stopPropagation(); m.querySelector('.has-sub').classList.toggle('open'); });
  placeMenu(m, btn);
}
function openProjMenu(btn, pid) {
  const m = $('#newMenu');
  const n = (CFG.lastTabs || []).filter(t => t.projectId === pid).length;
  m.innerHTML = `<button data-pact="restore" data-pid="${pid}">${n ? `${__('Son oturumları geri yükle')} <code>${n}</code>` : __('Son oturuma devam et')}</button><div class="sep"></div><button data-pact="ide" data-pid="${pid}">${__('IDE sahnesinde göster')}</button><button data-pact="open" data-pid="${pid}">${__("Klasörü Gezgin'de aç")}</button><button data-pact="refresh" data-pid="${pid}">${__('Oturum listesini yenile')}</button><div class="sep"></div><button class="danger" data-pact="remove" data-pid="${pid}">${__('Listeden kaldır')}</button>`;
  const p = proj(pid);
  if (p && window.pluginHost) m.innerHTML += pluginHost.menuHtml('project', { kind: 'project', projectId: p.id, name: p.name, path: p.path });
  placeMenu(m, btn);
}

/* ---------------- add project ----------------
   One window for every way in: pick a folder, drop one, paste a path, or take one Claude Code has
   already worked in (from its session history). Adding from the list keeps the window open so several
   can be added; the other ways add one and close it. In IDE mode the new project opens in the explorer. */
const DISC = { list: [], added: new Set(), q: '' };
async function openDiscover() {
  closeMenus();
  $('#discover').hidden = false;
  DISC.q = ''; DISC.added = new Set();
  $('#discBody').innerHTML = `
    <div class="ad-drop" id="adDrop">
      <i class="fa-solid fa-folder-open ad-ic"></i>
      <div class="ad-t"><b>${__('Klasörü buraya sürükle')}</b><span>${__('ya da bilgisayarından seç')}</span></div>
      <button class="btn primary" id="pickFolder"><i class="fa-solid fa-folder-plus"></i> ${__('Klasör seç…')}</button>
    </div>
    <form class="ad-path" id="adPathForm" autocomplete="off">
      <i class="fa-solid fa-link"></i>
      <input id="adPath" type="text" spellcheck="false" placeholder="${esc(__('ya da klasör yolunu yapıştır: {example}', { example: IS_WIN ? __('C:\\Projeler\\site') : __('~/projeler/site') }))}" aria-label="${esc(__('Klasör yolu'))}">
      <button class="btn" type="submit">${__('Ekle')}</button>
    </form>
    <div class="ad-msg" id="adMsg" hidden></div>
    <div class="ad-h">
      <span><i class="fa-solid fa-clock-rotate-left"></i> ${__("Claude'un çalıştığı klasörler")} <em id="adCount"></em></span>
      <label class="ad-q"><i class="fa-solid fa-magnifying-glass"></i><input id="adQ" type="text" spellcheck="false" placeholder="${esc(__('Süz…'))}" aria-label="${esc(__('Listeyi süz'))}"></label>
    </div>
    <div class="ad-list" id="discList">${'<div class="ad-row sk"><span></span><span></span></div>'.repeat(4)}</div>`;
  $('#adQ').addEventListener('input', e => { DISC.q = e.target.value.trim().toLowerCase(); renderDiscList(); });
  $('#adPathForm').addEventListener('submit', async e => {
    e.preventDefault();
    const v = $('#adPath').value.trim().replace(/^["']|["']$/g, '');
    if (v) addProjectPath(v, true);
  });
  const drop = $('#adDrop');
  drop.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; drop.classList.add('over'); } });
  drop.addEventListener('dragleave', e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); });
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    const paths = [...(e.dataTransfer.files || [])].map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length) addProjectPath(paths[0], true);
  });
  requestAnimationFrame(() => $('#pickFolder') && $('#pickFolder').focus());
  DISC.list = await api.invoke('project:discover').catch(() => []);
  renderDiscList();
}
function renderDiscList() {
  const el = $('#discList'); if (!el) return;
  const rows = DISC.list.filter(x => !DISC.q || x.path.toLowerCase().includes(DISC.q));
  $('#adCount').textContent = DISC.list.length ? DISC.list.length : '';
  if (!DISC.list.length) { el.innerHTML = `<div class="ad-empty"><i class="fa-regular fa-circle-check"></i>${__("Claude'un çalıştığı bütün klasörler zaten listende.")}</div>`; return; }
  if (!rows.length) { el.innerHTML = `<div class="ad-empty">${__('Eşleşen klasör yok.')}</div>`; return; }
  el.innerHTML = rows.map(x => {
    const done = DISC.added.has(x.path);
    return `<div class="ad-row${done ? ' done' : ''}"><i class="fa-regular fa-folder ad-fi"></i><span class="ad-info"><b>${esc(baseName(x.path))}</b><span title="${esc(x.path)}">${esc(x.path)}</span></span><span class="ad-time">${rel(x.mtime)}</span>`
      + (done ? `<span class="ad-ok"><i class="fa-solid fa-check"></i> ${__('Eklendi')}</span>` : `<button class="btn" data-addpath="${esc(x.path)}"><i class="fa-solid fa-plus"></i> ${__('Ekle')}</button>`) + '</div>';
  }).join('');
}
// add a folder by path; `close` for the single-add ways (picker, drop, pasted path)
async function addProjectPath(path, close) {
  const msg = $('#adMsg');
  const p = await api.invoke('project:addPath', path).catch(() => null);
  if (!p) { if (msg) { msg.hidden = false; msg.textContent = __('Bu yolda bir klasör bulunamadı: {path}', { path }); } return null; }
  if (msg) msg.hidden = true;
  DISC.added.add(path);
  if (close) $('#discover').hidden = true; else renderDiscList();
  await projectAdded(p);
  return p;
}
async function projectAdded(p) {
  if (!p) return;
  if (!S.projects.some(x => x.id === p.id)) S.projects.push(p);
  CFG.projects = S.projects;
  await refreshHistory(p.id);
  if (S.mode === 'ide') switchIdeProject(p.id);
  renderAll();
  toast(__('Proje eklendi'), p.path);
}

/* ---------------- monthly usage report ---------------- */
const REP = { hist: null, month: null };
const encodeDir = p => p.replace(/[^a-zA-Z0-9]/g, '-');
const modelName = m => /^claude-/.test(m) ? m.replace(/^claude-/, '').replace(/^(\w)/, c => c.toUpperCase()).replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1') : m;
const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(I18N.locale(), { month: 'long', year: 'numeric' }); };
async function openReport() {
  $('#report').hidden = false;
  $('#repBody').innerHTML = `<div class="rep-note">${__('Kayıtlar okunuyor…')}</div>`;
  REP.hist = await api.invoke('usage:history');
  const months = Object.keys(REP.hist).map(k => k.slice(0, 7)).filter((v, i, a) => a.indexOf(v) === i).sort();
  if (!REP.month || !months.includes(REP.month)) REP.month = months[months.length - 1] || null;
  renderReport();
}
function renderReport() {
  const h = REP.hist || {}, m = REP.month;
  if (!m) { $('#repBody').innerHTML = `<div class="rep-note">${__('Henüz kullanım kaydı yok.')}</div>`; return; }
  const months = Object.keys(h).map(k => k.slice(0, 7)).filter((v, i, a) => a.indexOf(v) === i).sort();
  const sumMonth = ym => Object.entries(h).filter(([k]) => k.startsWith(ym)).reduce((a, [, d]) => ({ t: a.t + d.t, c: a.c + d.c, n: a.n + (d.t > 0 ? 1 : 0) }), { t: 0, c: 0, n: 0 });
  const [y, mo] = m.split('-').map(Number);
  const nDays = new Date(y, mo, 0).getDate();
  const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const daily = Array.from({ length: nDays }, (_, i) => { const k = `${m}-${String(i + 1).padStart(2, '0')}`; return { k, d: i + 1, ...(h[k] || { t: 0, c: 0, rows: {} }) }; });
  const tot = sumMonth(m);
  const prevYm = months[months.indexOf(m) - 1];
  const prev = prevYm ? sumMonth(prevYm) : null;
  const peak = daily.reduce((a, b) => (b.c > a.c ? b : a), daily[0]);
  const delta = prev && prev.c > 0 ? Math.round((tot.c - prev.c) / prev.c * 100) : null;
  // breakdowns
  const names = Object.fromEntries(S.projects.map(p => [encodeDir(p.path), p.name]));
  const byProj = {}, byModel = {};
  for (const d of daily) for (const [rk, [t, , c]] of Object.entries(d.rows || {})) {
    const [proj, model] = rk.split('|');
    const pn = names[proj] || proj.replace(/^C--Users-[^-]+-/, '').replace(/-/g, ' ');
    (byProj[pn] = byProj[pn] || { t: 0, c: 0 }); byProj[pn].t += t; byProj[pn].c += c;
    const mn = modelName(model);
    (byModel[mn] = byModel[mn] || { t: 0, c: 0 }); byModel[mn].t += t; byModel[mn].c += c;
  }
  const table = (title, obj) => {
    const rows = Object.entries(obj).filter(([, v]) => v.t > 0).sort((a, b) => b[1].c - a[1].c);
    return `<table class="rep-t"><thead><tr><th>${title}</th><th class="n">${__('Token')}</th><th class="n">${__('≈ Dolar')}</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}<span class="share" style="width:${tot.c ? Math.max(2, v.c / tot.c * 100) : 0}%"></span></td><td class="n">${fmtTok(v.t)}</td><td class="n">${fmtUsd(v.c)}</td></tr>`).join('') || `<tr><td colspan="3">${__('Kayıt yok')}</td></tr>`}</tbody></table>`;
  };
  const max = Math.max(...daily.map(d => d.c), 0.01);
  const firstAvail = months[0];
  $('#repBody').innerHTML = `
    <div class="rep-top">
      <button class="btn" data-repmonth="${months[months.indexOf(m) - 1] || ''}" ${months.indexOf(m) > 0 ? '' : 'disabled'} aria-label="${esc(__('Önceki ay'))}">‹</button>
      <h3>${monthLabel(m)}</h3>
      <button class="btn" data-repmonth="${months[months.indexOf(m) + 1] || ''}" ${months.indexOf(m) < months.length - 1 ? '' : 'disabled'} aria-label="${esc(__('Sonraki ay'))}">›</button>
      <span class="sp"></span>
      <button class="btn" data-csv="${m}">${__('Bu ayı CSV kaydet')}</button>
      <button class="btn" data-csv="all">${__('Tümünü CSV kaydet')}</button>
    </div>
    <div class="rep-tiles">
      <div class="rep-tile"><small>${__('Toplam')}</small><b>${fmtTok(tot.t)}</b><span>${__('token')}</span></div>
      <div class="rep-tile"><small>${__('API karşılığı')}</small><b>${fmtUsd(tot.c)}</b><span>${delta == null ? __('önceki ay verisi yok') : __('{change} önceki aya göre', { change: `<span class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '▲' : '▼'} %${Math.abs(delta)}</span>` })}</span></div>
      <div class="rep-tile"><small>${__('Günlük ortalama')}</small><b>${fmtUsd(tot.n ? tot.c / tot.n : 0)}</b><span>${__('{n} aktif gün', { n: tot.n })}</span></div>
      <div class="rep-tile"><small>${__('En yoğun gün')}</small><b>${peak.c ? new Date(y, mo - 1, peak.d).toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short' }) : '–'}</b><span>${peak.c ? fmtUsd(peak.c) + ' · ' + __('{v} token', { v: fmtTok(peak.t) }) : ''}</span></div>
    </div>
    <div>
      <div class="rep-chart">${daily.map(d => `<div class="rep-bar ${d.k === todayKey ? 'today' : ''}" title="${esc(new Date(y, mo - 1, d.d).toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'long', year: 'numeric' }))}: ${esc(__('{v} token', { v: fmtTok(d.t) }))} · ≈ ${fmtUsd(d.c)}"><i style="height:${d.c ? Math.max(2, d.c / max * 100) : 0}%"></i></div>`).join('')}</div>
      <div class="rep-axis">${daily.map(d => `<span>${d.d === 1 || d.d % 5 === 0 ? d.d : ''}</span>`).join('')}</div>
    </div>
    <div class="rep-cols">${table(__('Proje'), byProj)}${table(__('Model'), byModel)}</div>
    <table class="rep-t"><thead><tr><th>${__('Ay')}</th><th class="n">${__('Aktif gün')}</th><th class="n">${__('Token')}</th><th class="n">${__('≈ Dolar')}</th></tr></thead><tbody>
      ${[...months].reverse().map(ym => { const s = sumMonth(ym); return `<tr data-month="${ym}" class="${ym === m ? 'on' : ''}"><td>${monthLabel(ym)}</td><td class="n">${s.n}</td><td class="n">${fmtTok(s.t)}</td><td class="n">${fmtUsd(s.c)}</td></tr>`; }).join('')}
    </tbody></table>
    <div class="rep-note">${__('Dolar tutarları API liste fiyatıyla karşılıktır; abonelikte ayrıca ödenmez. Claude Code oturum kayıtlarını yaklaşık 30 gün sonra siler. VoxStorm günlük toplamları kendi dosyasına da kaydeder; böylece geçmiş aylar uygulama kullanıldıkça birikir. Elindeki en eski kayıt: <b>{month}</b>.', { month: firstAvail ? monthLabel(firstAvail) : '–' })}</div>`;
}

/* ---------------- workflow window ----------------
   Clicking a workflow in the agents panel brings its session to the front and opens this window:
   phases on the left, the agents of the chosen phase on the right (model, tokens, time, what it is
   doing now, its result when it is done). Read from Claude Code's run files, refreshed while open. */
const WF = { ref: null, d: null, phase: null, open: new Set(), timer: null, html: '' };
const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? __('{h}sa {m}dk', { h, m }) : m ? __('{m}dk {s}sn', { m, s: s % 60 }) : __('{s}sn', { s }); };
function openWorkflow(id) {
  const a = S.agents.find(x => x.id === id); if (!a) return;
  if (a.tabId && tabById(a.tabId)) { if (S.mode !== 'claude' && S.mode !== 'ide') setMode('claude'); activate(a.tabId); }
  WF.ref = { a, sessionId: a.sessionId || (tabById(a.tabId) || {}).sessionId, runId: a.runId || '' };
  WF.d = null; WF.phase = null; WF.open = new Set(); WF.html = '';
  $('#wfTitle').innerHTML = `<i class="fa-solid fa-diagram-project"></i> ${esc(a.name)}`;
  $('#wfBody').innerHTML = `<div class="wf-none">${__('Workflow okunuyor…')}</div>`;
  $('#wfWin').hidden = false;
  clearInterval(WF.timer);
  WF.timer = setInterval(() => { if ($('#wfWin').hidden) { clearInterval(WF.timer); WF.timer = null; return; } loadWorkflow(); }, 2000);
  loadWorkflow();
}
async function loadWorkflow() {
  const r = WF.ref;
  if (!r || !r.sessionId) { $('#wfBody').innerHTML = `<div class="wf-none">${__('Workflow’un oturumu bulunamadı.')}</div>`; return; }
  let d = null;
  try { d = await api.invoke('workflow:detail', r.sessionId, r.runId || r.a.runId || ''); } catch (_) {}
  if (WF.ref !== r) return;
  if (!d || d.missing) { if (!WF.d) $('#wfBody').innerHTML = `<div class="wf-none">${__('Bu workflow’un kayıtları henüz yazılmadı; ilk ajan başlayınca burada görünür.')}</div>`; return; }
  if (!r.runId) r.runId = d.runId;
  if (d.name && /^workflow$/i.test(r.a.name)) { r.a.name = d.name; renderQueue(); }
  WF.d = d;
  renderWorkflow();
  if (!d.running) { clearInterval(WF.timer); WF.timer = null; }
}
function renderWorkflow() {
  const d = WF.d; if (!d) return;
  const now = Date.now();
  const phases = [...d.phases];
  for (const a of d.agents) if (a.phase && !phases.includes(a.phase)) phases.push(a.phase);
  const inPhase = p => d.agents.filter(a => (p === '*' ? true : a.phase === p));
  const stateOf = list => (list.some(a => a.state === 'failed') ? 'failed' : list.some(a => a.state === 'running') ? 'running' : list.length ? 'done' : 'wait');
  const icon = st => ({
    done: '<i class="wf-ic done fa-solid fa-check"></i>',
    running: '<i class="wf-ic running fa-solid fa-circle-notch fa-spin"></i>',
    failed: '<i class="wf-ic failed fa-solid fa-xmark"></i>',
    wait: '<i class="wf-ic wait fa-regular fa-circle"></i>',
  }[st]);
  let sel = WF.phase;
  if (sel == null || (sel !== '*' && !phases.includes(sel))) {
    const run = phases.find(p => inPhase(p).some(a => a.state === 'running'));
    sel = run || [...phases].reverse().find(p => inPhase(p).length) || phases[0] || '*';
  }
  const done = d.agents.filter(a => a.state === 'done').length;
  const failed = !d.running && (d.error || /fail|error|cancel|kill|abort/i.test(d.status));
  const st = d.running ? 'running' : failed ? 'failed' : 'done';
  const stLabel = d.running ? __('Çalışıyor') : failed ? (/cancel|kill|abort/i.test(d.status) ? __('Durduruldu') : __('Hata')) : __('Bitti');
  const agents = inPhase(sel);
  const agentHtml = a => {
    const open = WF.open.has(a.id) && a.result;
    const dur = a.first ? fmtDur((a.state === 'running' ? now : a.last) - a.first) : '';
    const info = [a.model ? modelName(a.model) : '', a.tokens ? __('{v} token', { v: fmtTok(a.tokens) }) : ''].filter(Boolean).join(' · ');
    const commits = (a.commits || []).map(c => `<code>${esc(c)}</code>`).join('');
    return `<div class="wf-ag">
      <div class="row" data-wfag="${a.id}">${icon(a.state)}<b>${esc(a.label || a.id)}</b><span class="m">${esc(info)}</span><span class="sp"></span><span class="d">${dur}</span>${a.result ? `<i class="fa-solid fa-chevron-${open ? 'up' : 'down'} m"></i>` : ''}</div>
      ${a.now ? `<div class="now" title="${esc(a.now)}">${esc(a.now)}</div>` : ''}
      ${open ? `<div class="res">${commits}${commits ? '\n' : ''}${esc(a.result)}</div>` : ''}
    </div>`;
  };
  const phaseHtml = (p, i) => {
    const l = inPhase(p);
    return `<button class="wf-ph ${sel === p ? 'on' : ''}" data-wfph="${esc(p)}">${icon(stateOf(l))}<span class="n">${i + 1}. ${esc(p)}</span><span class="c">${l.filter(a => a.state === 'done').length}/${l.length}</span></button>`;
  };
  const html = `
    <div class="wf-head">
      <div class="t"><h3>${esc(d.name)}</h3>${d.description ? `<p>${esc(d.description)}</p>` : ''}</div>
      <div class="meta"><span class="wf-st ${st}">${stLabel}</span><span>${__('{done}/{n} ajan', { done, n: d.agents.length })} · ${d.started ? fmtDur((d.ended || now) - d.started) : '–'}</span></div>
    </div>
    ${d.error ? `<div class="wf-err">${esc(d.error)}</div>` : ''}
    <div class="wf-main">
      <div class="wf-phases"><h4>${__('Fazlar')}</h4>
        ${phases.length > 1 ? `<button class="wf-ph ${sel === '*' ? 'on' : ''}" data-wfph="*">${icon(stateOf(d.agents))}<span class="n">${__('Tümü')}</span><span class="c">${done}/${d.agents.length}</span></button>` : ''}
        ${phases.map(phaseHtml).join('')}
      </div>
      <div class="wf-agents"><h4>${sel === '*' ? __('Bütün ajanlar') : esc(sel)} · ${__('{n} ajan', { n: agents.length })}</h4>
        ${agents.length ? agents.map(agentHtml).join('') : `<div class="wf-none">${__('Bu fazda henüz başlayan ajan yok.')}</div>`}
      </div>
    </div>
    <div class="wf-foot"><span>${esc(d.runId)}</span><span class="sp"></span>${WF.ref.a.tabId && tabById(WF.ref.a.tabId) ? `<button class="btn" data-wfgo="1">${__('Oturuma git')}</button>` : ''}</div>`;
  if (html === WF.html) return;
  const body = $('#wfBody');
  const box = body.querySelector('.wf-agents'), top = box ? box.scrollTop : 0;
  const res = [...body.querySelectorAll('.res')].map(x => x.scrollTop);
  WF.html = html;
  body.innerHTML = html;
  const nb = body.querySelector('.wf-agents'); if (nb) nb.scrollTop = top;
  body.querySelectorAll('.res').forEach((x, i) => { x.scrollTop = res[i] || 0; });
}

/* ---------------- settings ---------------- */
let setTab = 'ai';
const TONES = { samimi: __('Samimi'), resmi: __('Resmi'), kisa: __('Kısa ve öz') };
const LANGS = { tr: __('Türkçe'), en: __('İngilizce'), de: __('Almanca'), es: __('İspanyolca'), fr: __('Fransızca') };
const NOTIF_LABELS = { done: __('İş bittiğinde'), decision: __('Kararını beklediğinde (izin, plan, soru)'), subagent: __('Alt ajan açılınca / bitince'), workflow: __('Workflow açılınca / bitince'), quiet: __('Rahatsız etme (hepsini sustur)') };
const sw = (attr, on, label) => `<button class="sw" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" ${attr}></button>`;
/* ---------------- updates ---------------- */
let UPD = null;
const UPD_KIND = { nsis: __('Kurulum (Setup)'), portable: __('Taşınabilir (Portable)'), asar: __('Klasör (win-unpacked)'), mac: __('macOS uygulaması'), appimage: 'AppImage', linux: __('Linux paketi (.deb)'), dev: __('Geliştirme modu') };
function updateHTML() {
  const u = UPD || { status: 'idle', current: '', kind: '' };
  const up = Object.assign({ check: true, auto: true }, CFG.settings.update || {});
  const pct = Math.round((u.progress || 0) * 100);
  const ago = ms => (rel(ms) === __('şimdi') ? __('az önce') : __('{time} önce', { time: rel(ms) }));
  const ver = `<b>${esc(u.latest)}</b>`;
  const line = {
    idle: u.reason ? esc(u.reason) : __('Henüz denetlenmedi.'),
    checking: `<i class="fa-solid fa-circle-notch fa-spin"></i> ${__('Denetleniyor…')}`,
    none: `<i class="fa-solid fa-circle-check" style="color:var(--ok)"></i> ${__('Güncel')}${u.checkedAt ? ' · ' + __('son denetim {time}', { time: ago(u.checkedAt) }) : ''}`,
    available: __('{ver} sürümü var.', { ver }),
    downloading: `${__('{ver} indiriliyor… %{pct}', { ver, pct })}<span class="upd-bar"><i style="width:${pct}%"></i></span>`,
    ready: up.auto ? __('{ver} indirildi ve doğrulandı. Yeniden başlatınca kurulur; çıkışta da kendiliğinden kurulur.', { ver }) : __('{ver} indirildi ve doğrulandı. Yeniden başlatınca kurulur.', { ver }),
    manual: `${__('{ver} sürümü var.', { ver })} ${esc(u.reason)}`,
    error: `<i class="fa-solid fa-triangle-exclamation" style="color:var(--warn)"></i> ${esc(u.error)}`,
  }[u.status] || '';
  const btns = [];
  if (u.status === 'ready') btns.push(`<button class="btn primary" data-updgo><i class="fa-solid fa-rotate"></i> ${__('Yeniden başlat ve güncelle')}</button>`);
  if (u.status === 'available') btns.push(`<button class="btn primary" data-upddl><i class="fa-solid fa-download"></i> ${__('İndir')}</button>`);
  if (['manual', 'available', 'ready'].includes(u.status) && u.url) btns.push(`<button class="btn" data-updpage><i class="fa-brands fa-github"></i> ${__('Sürüm sayfası')}</button>`);
  if (u.kind && u.kind !== 'dev' && u.status !== 'checking' && u.status !== 'downloading') btns.push(`<button class="btn" data-updcheck><i class="fa-solid fa-arrows-rotate"></i> ${__('Güncellemeleri denetle')}</button>`);
  return `<h4>${__('Sürüm')}</h4>
    <div class="upd"><div class="upd-top"><b>VoxStorm ${esc(u.current)}</b><span>${esc(UPD_KIND[u.kind] || '')}</span></div>
      <div class="upd-line">${line}</div>${btns.length ? `<div class="upd-btns">${btns.join('')}</div>` : ''}
      ${u.notes && u.status !== 'none' ? `<details class="upd-notes"><summary>${__('{ver} sürümündeki yenilikler', { ver: esc(u.latest) })}</summary><pre>${esc(u.notes)}</pre></details>` : ''}</div>
    <div class="set-row"><span>${__('Güncellemeleri kendiliğinden denetle')}<small>${__("Açılışta ve 6 saatte bir GitHub'daki sürümlere bakar")}</small></span>${sw('data-upd="check"', up.check, __('Güncellemeleri denetle'))}</div>
    <div class="set-row"><span>${__('Kendiliğinden indir ve çıkışta kur')}<small>${__('Kapalıysa yalnızca haber verir')}</small></span>${sw('data-upd="auto"', up.auto, __('Kendiliğinden indir'))}</div>`;
}
function renderUpdBtn() {
  const b = $('#updBtn'); if (!b || !UPD) return;
  b.hidden = !['ready', 'available', 'manual', 'downloading'].includes(UPD.status);
  b.classList.toggle('ready', UPD.status === 'ready');
  b.title = UPD.status === 'ready' ? __('VoxStorm {ver} hazır: yeniden başlatınca kurulur', { ver: UPD.latest })
    : UPD.status === 'downloading' ? __('VoxStorm {ver} indiriliyor (%{pct})', { ver: UPD.latest, pct: Math.round(UPD.progress * 100) }) : __('VoxStorm {ver} çıktı', { ver: UPD.latest });
}
async function updateAction(d) {
  if (d.upd) { setCfg({ settings: { update: { [d.upd]: !Object.assign({ check: true, auto: true }, CFG.settings.update || {})[d.upd] } } }).then(renderSettings); return; }
  if (d.updcheck !== undefined) { UPD = await api.invoke('update:check'); }
  else if (d.upddl !== undefined) { api.invoke('update:download'); return; }
  else if (d.updpage !== undefined) { if (UPD && UPD.url) api.invoke('shell:openGithub', UPD.url); return; }
  else if (d.updgo !== undefined) {
    const open = S.tabs.filter(t => !t.exited && t.kind !== 'watch' && t.kind !== 'agent').length;
    if (open && !(await uiConfirm({ title: __('Güncellensin mi?'), message: __('{n} terminal kapanacak.', { n: open }), detail: __('Claude oturumları yeni sürüm açılınca geri yüklenir.'), ok: __('Yeniden başlat ve güncelle'), icon: 'fa-rotate' }))) return;
    if (!(await api.invoke('update:restart'))) toast(__('Güncelleme başlatılamadı'));
    return;
  }
  renderUpdBtn(); renderSettings();
}
api.on('update:state', st => { UPD = st; renderUpdBtn(); if (!$('#settings').hidden && setTab === 'hakkinda') renderSettings(); });

let CLEANUP = null; // ~/.claude/settings.json cleanupPeriodDays (null = Claude Code's default, 30)
function openSettings(tab) {
  if (tab) setTab = tab; $('#settings').hidden = false; closeMenus(); renderSettings();
  api.invoke('claude:getCleanup').then(v => { if (v !== CLEANUP) { CLEANUP = v; renderSettings(); } }).catch(() => {});
}
function renderSettings() {
  if ($('#settings').hidden) return;
  if (setTab === 'claude' || setTab === 'codex' || setTab === 'hitap') { setFocus = setTab === 'hitap' ? 'ortak' : setTab; setTab = 'ai'; }
  const st = CFG.settings;
  $('#setNav').innerHTML = [['ai', __('Yapay zekâ')], ['dil', __('Dil · Language')], ['tema', __('Tema')], ['bildirim', __('Bildirimler')], ['pencere', __('Pencere')], ['eklenti', __('Eklentiler')], ['kisayol', __('Kısayollar')], ['hakkinda', __('Hakkında')]].map(([k, l]) => `<button class="set-tab ${k === setTab ? 'on' : ''}" data-settab="${k}">${l}</button>`).join('');
  let h = '';
  if (setTab === 'ai') { let h1 = '', h2 = '', h3 = ''; {
    h1 = agentPickHtml() + `<h4>${__('Sana nasıl hitap edilsin?')}</h4>
      <input type="text" id="fName" data-field="name" value="${esc(st.name)}" placeholder="${esc(__('Boş bırakırsan hitap kullanılmaz'))}">
      <div class="chips">${[...new Set([firstName((CFG.identity || {}).name), __('Başkanım'), __('Hocam'), __('Şefim'), __('Patron')].filter(Boolean))].map(c => `<button class="chip-btn ${st.name === c ? 'on' : ''}" data-hitap="${esc(c)}">${esc(c)}</button>`).join('')}<button class="chip-btn ${!addr() ? 'on' : ''}" data-hitap="">${__('Hitapsız')}</button></div>
      <p class="set-note">${(CFG.identity || {}).name ? __('Adın {src} ayarlarından alındı: <b>{name}</b>.', { src: (CFG.identity || {}).source === 'github' ? 'GitHub' : 'git', name: esc(CFG.identity.name) }) + ' ' : ''}${__('Bir oturumda “bana … diye hitap et” dersen burası da güncellenir.')}</p>
      <h4>${__('Konuşma tonu')}</h4>
      <div class="seg">${Object.keys(TONES).map(k => `<button class="${st.tone === k ? 'on' : ''}" data-tone="${k}">${TONES[k]}</button>`).join('')}</div>
      <h4>${__('Yanıt dili')}</h4>
      <select id="fLang" data-field="lang">${Object.keys(LANGS).map(k => `<option value="${k}" ${st.lang === k ? 'selected' : ''}>${LANGS[k]}</option>`).join('')}</select>
      <h4>${__('Ek talimatlar')}</h4>
      <textarea id="fExtra" data-field="extra" rows="3" placeholder="${esc(__('Her satır bir talimat. Ör: Commit mesajlarını İngilizce yaz.'))}">${esc(st.extra)}</textarea>
      <h4>${__('Oturumlara eklenecek metin')}</h4>
      <pre class="md" id="promptPrev">…</pre>
      <p class="set-note">${__("Bu metin VoxStorm'tan başlatılan Claude ve Codex oturumlarına eklenir. CLAUDE.md ve AGENTS.md dosyalarına dokunulmaz. Değişiklik yeni açılan oturumlarda geçerli olur.")}</p>
      <h4>${__('SSH ve veritabanı bağlantıları')}</h4>
      <div class="set-row"><span>${__('Claude ve Codex, VoxStorm’daki bağlantıları kullanabilsin')}<small>${__('Ajan kayıtlı SSH sunucularını ve veritabanlarını yalnızca adlarıyla görür. Bir bağlantıyı ilk kullanmak istediğinde sana sorulur (Evet / Hayır, “her zaman hatırla”). Bağlantıyı VoxStorm kurar; adres, kullanıcı adı ve parola ajana hiç verilmez, ajan yalnızca komutun ya da sorgunun çıktısını görür.')}</small></span>${sw('data-set="agentLink"', st.agentLink !== false, __('Bağlantıları ajanlara aç'))}</div>
      <p class="set-note">${__('Hatırlanan kararları bağlantının düzenleme penceresindeki “Claude / Codex erişimi” alanından değiştirebilirsin. Değişiklik yeni açılan oturumlarda geçerli olur.')}</p>`;
  } {
    const c = CFG.settings.claude || {};
    const custom = c.model && !MODELS.some(([k]) => k === c.model);
    h2 = `<h4>${__('Varsayılan model')}</h4>
      <select id="cModel">${MODELS.map(([k, l]) => `<option value="${k}" ${(custom ? '__custom' : c.model || '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="text" id="cModelCustom" placeholder="${esc(__('Tam model adı, ör. claude-opus-5-5'))}" value="${custom ? esc(c.model) : ''}" ${custom ? '' : 'hidden'}>
      <h4>${__('Efor seviyesi')}</h4>
      <div class="seg">${EFFORTS.map(([k, l]) => `<button class="${(c.effort || '') === k ? 'on' : ''}" data-ceffort="${k}">${l}</button>`).join('')}</div>
      <h4>${__('İzin modu')}</h4>
      <div class="pm-list">${PERM_MODES.map(([k, l, d]) => `<button class="pm ${(c.permissionMode || '') === k ? 'on' : ''} ${k === 'bypassPermissions' ? 'danger' : ''}" data-cpm="${k}"><b>${l}</b><small>${d}</small></button>`).join('')}</div>
      ${c.permissionMode === 'bypassPermissions' ? `<p class="set-warn">${__('Dikkat: Claude hiçbir şey sormadan komut çalıştırır, dosya yazar ve siler. Sadece güvendiğin projelerde kullan. İlk açılışta Claude bir onay isteyebilir.')}</p>` : ''}
      <h4>Remote Control</h4>
      <div class="set-row"><span>${__('Oturumlar Remote Control açık başlasın')}<small>${__('Oturumu claude.ai veya telefondaki Claude uygulamasından da sürdürebilirsin. Oturum adı: “proje · VoxStorm”.')}</small></span>${sw('data-cset="remoteControl"', c.remoteControl, 'Remote Control')}</div>
      <h4>Chrome</h4>
      <div class="set-row"><span>${__('Oturumlar Chrome ile başlasın')}<small>${__('Claude Code <code>--chrome</code> ile açılır; Claude in Chrome uzantısı üzerinden tarayıcını kullanabilir.')}</small></span>${sw('data-cset="chrome"', c.chrome, __('Chrome ile başlat'))}</div>
      <h4>${__('Varsayılan açılış komutu')}</h4>
      <input type="text" id="cCommand" spellcheck="false" placeholder="claude" value="${esc(c.command || '')}">
      <p class="set-note">${__('Boş bırakılırsa PATH\'teki <code>claude</code> çalışır. Doldurursan oturumlar bu komutla açılır; VoxStorm kendi argümanlarını (<code>--session-id</code>, <code>--settings</code>, model, izin modu…) sonuna ekler. Ör: <code>claude --verbose</code>, <code>"C:\\Araçlar\\claude.exe"</code>, <code>npx @anthropic-ai/claude-code</code>. Boşluk içeren yolları çift tırnakla yaz.')}</p>
      <p class="set-note">${__("Bu ayarlar VoxStorm'tan yeni açılan ve devam ettirilen oturumlara uygulanır; açık oturumlar etkilenmez. Boş bırakılanlarda Claude Code kendi ayarını kullanır. Tek bir oturum için izin modunu “+ Oturum ▾” menüsünden de seçebilirsin.")}</p>
      <h4>${__('Oturum geçmişi ne kadar saklansın?')}</h4>
      <div class="seg">${[30, 90, 180, 365].map(n => `<button class="${(CLEANUP || 30) === n ? 'on' : ''}" data-cleanup="${n}">${n === 30 ? __('{n} gün (varsayılan)', { n }) : __('{n} gün', { n })}</button>`).join('')}</div>
      ${CLEANUP && ![30, 90, 180, 365].includes(CLEANUP) ? `<p class="set-note">${__('Şu anki değer: {n} gün.', { n: CLEANUP })}</p>` : ''}
      <p class="set-note">${__('Claude Code, bu süreden eski oturum kayıtlarını siler; silinen oturumlar geçmişte ve proje listesinde görünmez. Bu, <code>~/.claude/settings.json</code> içindeki <code>cleanupPeriodDays</code> ayarıdır; VoxStorm dışında açtığın oturumlar için de geçerlidir. Daha önce silinenleri geri getirmez.')}</p>`;
  } {
    const c = CFG.settings.codex || {};
    h3 = !INFO.codex ? `<p class="set-note">${__('Codex kurulu değil.')}</p>` : `<h4>${__('Varsayılan model')}</h4>
      <input type="text" id="xModel" spellcheck="false" placeholder="${esc(__('Boş: Codex’in varsayılanı (ör. gpt-6.2-sol)'))}" value="${esc(c.model || '')}">
      <h4>${__('Akıl yürütme eforu')}</h4>
      <div class="seg">${CODEX_EFFORTS.map(([k, l]) => `<button class="${(c.effort || '') === k ? 'on' : ''}" data-xeffort="${k}">${l}</button>`).join('')}</div>
      <h4>${__('Onay modu')}</h4>
      <div class="pm-list">${CODEX_MODES.map(([k, l, d]) => `<button class="pm ${(c.mode || '') === k ? 'on' : ''} ${k === 'full' ? 'danger' : ''}" data-xmode="${k}"><b>${l}</b><small>${d}</small></button>`).join('')}</div>
      ${c.mode === 'full' ? `<p class="set-warn">${__('Dikkat: Codex hiçbir şey sormadan ve korumalı alan olmadan komut çalıştırır, dosya yazar ve siler. Sadece güvendiğin projelerde kullan.')}</p>` : ''}
      <h4>${__('Web araması')}</h4>
      <div class="set-row"><span>${__('Oturumlar web araması açık başlasın')}<small>${__('Codex <code>--search</code> ile açılır.')}</small></span>${sw('data-xset="search"', c.search, __('Web araması'))}</div>
      <h4>${__('Varsayılan açılış komutu')}</h4>
      <input type="text" id="xCommand" spellcheck="false" placeholder="codex" value="${esc(c.command || '')}">
      <p class="set-note">${__('Boş bırakılırsa PATH\'teki <code>codex</code> çalışır. VoxStorm kendi argümanlarını (hook’lar, model, onay modu…) sonuna ekler.')}</p>
      <p class="set-note">${__('VoxStorm, oturumun durumunu (çalışıyor / izin bekliyor / bitti) Codex’in hook’larıyla öğrenir. Bu hook’lar komut satırında verilir, <code>~/.codex</code> içinde hiçbir şey değişmez. Port her açılışta değiştiği için Codex’in hook onayı atlanır (<code>--dangerously-bypass-hook-trust</code>); bu yüzden VoxStorm’dan açılan oturumlarda, kendi tanımlayıp henüz onaylamadığın hook’lar da sorulmadan çalışır. Hitap ve dil tercihlerin Codex’e de iletilir.')}</p>`;
  } h = aiSettingsHtml(h1, h2, h3); } else if (setTab === 'dil') {
    // interface language (src/i18n): read once at start, so a change asks for a restart
    const cur = st.uiLang || 'tr', want = I18N.resolve(cur, navigator.languages), sys = I18N.resolve('auto', navigator.languages);
    const nameOf = c => (I18N.LANGS.find(l => l[0] === c) || [])[1] || c;
    h = `<h4>${__('Arayüz dili')}</h4>`
      + `<select data-field="uiLang">${[['auto', __('Sistem dili ({name})', { name: nameOf(sys) })], ...I18N.LANGS.map(l => [l[0], l[1]])].map(([k, l]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
      + (want !== INFO.uiLang ? `<div class="set-row"><span>${__('Yeni dil yeniden başlatınca uygulanır')}<small>${__('Açık Claude ve Codex oturumları yeniden açılınca geri gelir.')}</small></span><button class="btn primary" data-relaunch>${__('Şimdi yeniden başlat')}</button></div>` : '')
      + `<p class="set-note">${__('Claude ve Codex’in hangi dilde yanıt vereceğini Yapay zekâ sekmesindeki “Yanıt dili”nden seçersin.')}</p>`;
  } else if (setTab === 'tema') {
    const tc = st.termColors || 'windows';
    h = `<h4>${__('Tema')}</h4>` + skinOptions()
      + `<h4>${__('Terminal yazı renkleri')}</h4><div class="seg"><button class="${tc === 'windows' ? 'on' : ''}" data-termcolors="windows">Windows Terminal</button><button class="${tc === 'theme' ? 'on' : ''}" data-termcolors="theme">${__('Temaya uyumlu')}</button></div><p class="set-note">${__('Windows Terminal: Claude Code normal Windows terminalindeki renklerle görünür (beyaz yazı, mavi bağlantılar).')}</p>`;
  } else if (setTab === 'bildirim') {
    h = `<h4>${__('Hangi durumlarda Windows bildirimi gelsin?')}</h4>` + Object.keys(NOTIF_LABELS).map(k => `<div class="set-row"><span>${NOTIF_LABELS[k]}</span>${sw(`data-notif="${k}"`, st.notif[k], NOTIF_LABELS[k])}</div>`).join('')
      + (() => { const cur = !st.sound ? 'off' : (st.soundStyle || 'claudelot'); return `<h4>${__('Bildirim sesi')}</h4><div class="seg">${[['claudelot', __('VoxStorm sesi')], ['windows', __('Windows sesi')], ['off', __('Sessiz')]].map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" data-soundstyle="${k}">${l}</button>`).join('')}</div>`
        + (cur === 'claudelot' ? `<div class="chips" style="margin-top:8px"><button class="chip-btn" data-chime="done"><i class="fa-solid fa-play"></i> ${__('İş bitti')}</button><button class="chip-btn" data-chime="decision"><i class="fa-solid fa-play"></i> ${__('Karar bekliyor')}</button><button class="chip-btn" data-chime="subagent"><i class="fa-solid fa-play"></i> ${__('Ajan / workflow')}</button></div>` : ''); })()
      + `<p class="set-note">${__('O an baktığın terminal için bildirim gösterilmez.')}</p>`;
  } else if (setTab === 'pencere') {
    h = `<h4>${__('Pencere')}</h4>`
      + `<div class="set-row"><span>${__('Kapat düğmesi tepsiye küçültsün')}<small>${__('Kapalıysa × düğmesi çıkış onayı sorar')}</small></span>${sw('data-set="closeToTray"', st.closeToTray, __('Tepsiye küçült'))}</div>`
      + `<div class="set-row"><span>${__('Açılışta karşılama ekranını göster')}<small>${__('Proje seçme ve arama penceresi')}</small></span>${sw('data-set="welcome"', st.welcome !== false, __('Karşılama ekranı'))}</div>`
      + `<div class="set-row"><span>${__('Windows açılınca başlat')}<small>${__('Doğrudan sistem tepsisine başlar')}</small></span>${sw('data-set="autostart"', st.autostart, __('Windows ile başlat'))}</div>`
      + `<p class="set-note">${__('Uygulamadan tamamen çıkmak için: sistem tepsisindeki simgeye sağ tıkla → Çık.')}</p>`;
  } else {
    h = setTab === 'eklenti' ? (window.pluginHost ? pluginHost.settingsHtml() : '') : setTab === 'kisayol' ? kisayolHTML() : updateHTML() + `<h4>${__('Bağlantı')}</h4><div class="kv">
      <span>Claude Code</span><span>${INFO.claude ? `<code>${esc(INFO.claude)}</code>` : __('<b style="color:var(--warn)">Bulunamadı.</b> Claude Code kurulu ve PATH içinde olmalı.')}</span>
      <span>${__('Bildirim portu')}</span><span><code>127.0.0.1:${INFO.hookPort}</code></span>
      <span>${__('Hook ayarları')}</span><span><code>${esc(INFO.hookSettings)}</code></span>
      <span>${__('Ek talimat dosyası')}</span><span><code>${esc(INFO.appendPrompt)}</code></span></div>
      <p class="set-note">${__('VoxStorm, başlattığı her Claude oturumuna kendi hook ayarlarını <code>--settings</code> ile verir. Senin <code>~/.claude/settings.json</code> dosyan değiştirilmez. Uygulama dışında açılan oturumlar burada görünmez ama geçmişleri listelenir.')}</p>`;
  }
  const body = $('#setBody'), keep = body.dataset.tab === setTab ? body.scrollTop : 0; // a re-render (a setting changed) stays where it was
  body.innerHTML = h; body.dataset.tab = setTab; body.scrollTop = keep;
  if (setTab === 'ai') updatePromptPreview();
  if (setFocus) { const sec = body.querySelector(`[data-setsec="${setFocus}"]`); setFocus = null; if (sec) { sec.open = true; sec.scrollIntoView({ block: 'start' }); } }
}
/* the AI page: what both share on top, then Claude and Codex as sections that fold (remembered) */
let setFocus = null; // the section to show when the page opens ('ortak' | 'claude' | 'codex')
// Ortak starts open, Claude and Codex folded; what the user opens or folds is remembered
const SET_FOLDED = (() => { try { const v = localStorage.getItem('vs.setFolded.v2'); return new Set(v ? JSON.parse(v) : ['claude', 'codex']); } catch (_) { return new Set(['claude', 'codex']); } })();
function aiSettingsHtml(shared, claude, codex) {
  const sec = (k, icon, title, sub, body) => `<details class="set-sec" data-setsec="${k}" ${SET_FOLDED.has(k) ? '' : 'open'}><summary><i class="${icon}"></i><b>${title}</b><small>${esc(sub)}</small><i class="fa-solid fa-chevron-down sec-car"></i></summary><div class="set-sec-b">${body}</div></details>`;
  return sec('ortak', 'fa-solid fa-user', __('Ortak'), __('Claude ve Codex için: varsayılan yapay zekâ, hitap, ton ve dil'), shared)
    + sec('claude', 'fa-brands fa-claude', 'Claude', claudeSummary(), claude)
    + sec('codex', 'fa-brands fa-openai', 'Codex', INFO.codex ? codexSummary() : __('kurulu değil'), codex);
}
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches || !d.matches('.set-sec')) return;
  if (d.open) SET_FOLDED.delete(d.dataset.setsec); else SET_FOLDED.add(d.dataset.setsec);
  try { localStorage.setItem('vs.setFolded.v2', JSON.stringify([...SET_FOLDED])); } catch (_) {}
}, true);
let prevTimer = null;
function updatePromptPreview() {
  clearTimeout(prevTimer);
  prevTimer = setTimeout(async () => { const el = $('#promptPrev'); if (el) el.textContent = await api.invoke('prompt:preview'); }, 250);
}

/* ---------------- events ---------------- */
function closeMenus() { $('#newMenu').hidden = true; $('#skinMenu').hidden = true; $('#pop').hidden = true; closeIdeMenu(); }
function bindEvents() {
  bindDock();
  // right click on a session (sidebar row, IDE panel tab, past session): context menu
  // (the top tab strip has its own handler in tabgroups.js)
  document.addEventListener('contextmenu', e => {
    // right click on a project's row: the same menu as its "…" button, at the mouse
    const row = e.target.closest('#side .proj-row');
    if (row) {
      const b = row.querySelector('[data-projmenu]');
      if (!b) return;
      e.preventDefault();
      const at = { getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) };
      $('#newMenu').dataset.for = 'p' + b.dataset.projmenu;
      openProjMenu(at, b.dataset.projmenu);
      const m = $('#newMenu'), w = $('#win').getBoundingClientRect(); // opens to the right of the mouse
      m.style.left = Math.max(8, Math.min(e.clientX - w.left, w.width - m.offsetWidth - 8)) + 'px';
      return;
    }
    const el = e.target.closest('#tabs [data-tab], #ptabs [data-tab], #side [data-tab], #side [data-watch], #side [data-resume], #newMenu [data-resume]');
    if (!el) return;
    if (el.dataset.tab && (tabById(el.dataset.tab) || {}).kind === 'agent') return;
    e.preventDefault();
    $('#newMenu').hidden = true;
    if (el.dataset.tab && tabById(el.dataset.tab)) openTabMenu(e, el.dataset.tab);
    else openSessMenu(e, el);
  });
  document.addEventListener('click', async e => {
    const el = e.target.closest('button,[data-tab],tr[data-month]');
    if (!e.target.closest('#newMenu,[data-newmenu],[data-projmenu]')) $('#newMenu').hidden = true;
    if (!$('#startPanel').hidden && !e.target.closest('#startPanel,#startBtn,#newMenu,[data-startnew]')) closeStartPanel();
    if (e.target.closest('#newMenu [data-newkind],#newMenu [data-resume],#newMenu [data-pact]')) closeStartPanel();
    if (!e.target.closest('#skinMenu,#skinBtn')) $('#skinMenu').hidden = true;
    if (!e.target.closest('#pop,#bellBtn')) $('#pop').hidden = true;
    if (e.target.id === 'settings') { $('#settings').hidden = true; return; }
    if (e.target.id === 'discover') { $('#discover').hidden = true; return; }
    if (e.target.id === 'report') { $('#report').hidden = true; return; }
    if (e.target.id === 'wfWin') { $('#wfWin').hidden = true; return; }
    if (!el) return;
    const d = el.dataset;
    if (d.gsync) { runSync(d.gsync, d.act); return; }
    if (d.gitopen) { openGitFor(d.gitopen); return; }
    if (d.startnew) { await showPanel('side'); openStartPanel(); }
    else if (d.panel) togglePanel(d.panel);
    else if (d.watch) { if (S.mode === 'claude' || S.mode === 'ide') openWatch(d.watch); }
    else if (d.agent) openAgentView(d.agent);
    else if (d.wf) openWorkflow(d.wf);
    else if (d.takeover) takeOverSession(d.takeover);
    else if (d.continue) continueHere(d.continue);
    else if (d.mode) setMode(d.mode);
    else if (d.tab) { if (S.mode === 'ide' && tabById(d.tab) && tabById(d.tab).projectId !== IDE.project) switchIdeProject(tabById(d.tab).projectId); activate(d.tab); $('#pop').hidden = true; }
    else if (d.close) closeTab(d.close);
    else if (d.resume) {
      const h = (S.history[d.pid] || []).find(x => x.id === d.resume);
      openTerminal({ kind: 'claude', projectId: d.pid, resume: d.resume, title: h ? shorten(h.title, 48) : __('Oturum') });
    }
    else if (d.new) openTerminal({ kind: 'claude', projectId: d.new });
    else if (d.newmenu) { const m = $('#newMenu'); if (!m.hidden && m.dataset.for === d.newmenu + el.className) m.hidden = true; else { m.dataset.for = d.newmenu + el.className; openNewMenu(el, d.newmenu); } }
    else if (d.projmenu) { const m = $('#newMenu'); m.dataset.for = 'p' + d.projmenu; openProjMenu(el, d.projmenu); }
    else if (d.newkind) { $('#newMenu').hidden = true; openTerminal(d.newkind === 'claude' ? { kind: 'claude', agent: 'claude', projectId: d.pid, overrides: d.pm ? { permissionMode: d.pm } : undefined } : d.newkind === 'codex' ? { kind: 'claude', agent: 'codex', projectId: d.pid } : { kind: 'shell', shell: d.newkind, projectId: d.pid }); }
    else if (d.pact) {
      $('#newMenu').hidden = true;
      const p = proj(d.pid); if (!p) return;
      if (d.pact === 'restore') restoreTabs(p.id);
      else if (d.pact === 'ide') { if (S.mode !== 'ide') setMode('ide'); switchIdeProject(p.id); }
      else if (d.pact === 'open') api.invoke('project:open', p.path);
      else if (d.pact === 'refresh') { await refreshHistory(p.id); renderSide(); }
      else if (d.pact === 'remove' && await uiConfirm({ title: __('Proje kaldırılsın mı?'), message: __('"{name}" listeden kaldırılsın mı?', { name: p.name }), detail: __('Klasör ve oturum geçmişi silinmez.'), ok: __('Kaldır'), danger: true })) {
        S.projects = await api.invoke('project:remove', p.id); CFG.projects = S.projects;
        if (IDE.project === p.id) IDE.project = null;
        renderAll();
      }
    }
    else if (d.toggle) { S.collapsed[d.toggle] = !isCollapsed(d.toggle); renderSide(); }
    else if (d.more) { S.showAll[d.more] = !S.showAll[d.more]; renderSide(); }
    else if (d.dec) decide(d.dec, d.c);
    else if (d.skin) { await setCfg({ settings: { skin: d.skin } }); applySkin(d.skin); renderSkinMenu(); renderSettings(); $('#skinMenu').hidden = true; }
    else if (d.relaunch != null) {
      const n = S.tabs.filter(t => t.term && !t.exited).length;
      if (n && !(await uiConfirm({ title: __('Yeniden başlatılsın mı?'), message: __('{n} terminal kapanacak.', { n }), detail: __('Claude ve Codex oturumları yeniden açılınca geri gelir.'), ok: __('Yeniden başlat'), icon: 'fa-rotate' }))) return;
      api.invoke('app:relaunch');
    }
    else if (d.themeedit != null) { $('#skinMenu').hidden = true; Themes.openEditor(d.themeedit); }
    else if (d.themenew != null) { $('#skinMenu').hidden = true; Themes.openEditor(null); }
    else if (d.themeclaude != null) { $('#skinMenu').hidden = true; $('#settings').hidden = true; Themes.designWithClaude(); }
    else if (d.proj) switchIdeProject(d.proj);
    else if (d.dir) { IDE.expanded[d.dir] = !IDE.expanded[d.dir]; renderTree(); }
    else if (d.fclose) closeFile(d.fclose);
    else if (d.file) openFile(d.file);
    else if (d.settab) { setTab = d.settab; renderSettings(); }
    else if (d.hitap !== undefined) { await setCfg({ settings: { name: d.hitap } }); renderSettings(); }
    else if (d.tone) { await setCfg({ settings: { tone: d.tone } }); renderSettings(); }
    else if (d.termcolors) { await setCfg({ settings: { termColors: d.termcolors } }); applySkin(CFG.settings.skin); renderSettings(); }
    else if (d.soundstyle) { await setCfg({ settings: d.soundstyle === 'off' ? { sound: false } : { sound: true, soundStyle: d.soundstyle } }); renderSettings(); if (d.soundstyle === 'claudelot') playChime('done'); }
    else if (d.chime) playChime(d.chime);
    else if (d.set) { await setCfg({ settings: { [d.set]: !CFG.settings[d.set] } }); renderSettings(); }
    else if (d.notif) { await setCfg({ settings: { notif: { [d.notif]: !CFG.settings.notif[d.notif] } } }); renderSettings(); }
    else if (d.addpath) addProjectPath(d.addpath, false);
    else if (d.mdmode) { const fp = ist().file; if (d.mdmode === 'view') IDE.mdView.add(fp); else IDE.mdView.delete(fp); showFile(); if (d.mdmode === 'src') IDE.cm.focus(); }
    else if (d.tb) toolbar(d.tb);
    else if (d.report) openReport();
    else if (d.usageai) { setCfg({ settings: { usageAgent: d.usageai } }).then(renderUsage); }
    else if ('usagemode' in d) { setCfg({ settings: { usageMode: usageMode() === 'plan' ? 'tokens' : 'plan' } }).then(renderUsage); }
    else if (d.planretry) { PLAN.data = null; loadPlan(true); renderUsage(); }
    else if (d.repmonth) { REP.month = d.repmonth; renderReport(); }
    else if (el.closest('tr[data-month]')) { REP.month = el.closest('tr[data-month]').dataset.month; renderReport(); }
    else if (d.csv) { const f = await api.invoke('usage:exportCsv', d.csv === 'all' ? null : d.csv); if (f) toast(__('CSV kaydedildi'), f); }
    else if (el.id === 'saveBtn') saveFile();
    else if (el.id === 'pickFolder') { const p = await api.invoke('project:add'); if (p) { $('#discover').hidden = true; await projectAdded(p); } }
    else if (el.id === 'ideAddProj') openDiscover();
  });
  $('#minBtn').onclick = () => api.send('win:min');
  $('#maxBtn').onclick = () => api.send('win:max');
  $('#closeBtn').onclick = () => api.send('win:close');
  $('#setBtn').onclick = () => openSettings();
  $('#setClose').onclick = () => { $('#settings').hidden = true; };
  $('#discClose').onclick = () => { $('#discover').hidden = true; };
  $('#repClose').onclick = () => { $('#report').hidden = true; };
  $('#wfClose').onclick = () => { $('#wfWin').hidden = true; };
  $('#wfBody').addEventListener('click', e => {
    const ph = e.target.closest('[data-wfph]'), ag = e.target.closest('[data-wfag]'), go = e.target.closest('[data-wfgo]');
    if (ph) { WF.phase = ph.dataset.wfph; renderWorkflow(); }
    else if (ag) { const id = ag.dataset.wfag; if (WF.open.has(id)) WF.open.delete(id); else WF.open.add(id); renderWorkflow(); }
    else if (go) { $('#wfWin').hidden = true; if (WF.ref && tabById(WF.ref.a.tabId)) activate(WF.ref.a.tabId); }
  });
  $('#repInfoBtn').onclick = () => { const n = $('#repInfo'); n.hidden = !n.hidden; $('#repInfoBtn').setAttribute('aria-expanded', !n.hidden); };
  $('#addProjBtn').onclick = () => { closeStartPanel(); openDiscover(); };
  $('#startBtn').onclick = () => ($('#startPanel').hidden ? openStartPanel() : closeStartPanel());
  $('#startQ').addEventListener('input', () => { START.sel = 0; renderStartList(); });
  $('#startQ').addEventListener('keydown', e => {
    const n = START.view.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); START.sel = Math.min(n - 1, START.sel + 1); renderStartList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); START.sel = Math.max(0, START.sel - 1); renderStartList(); }
    else if (e.key === 'Enter') { e.preventDefault(); const p = START.view[START.sel]; if (p) { closeStartPanel(); openTerminal({ kind: 'claude', projectId: p.id }); } }
    else if (e.key === 'Escape') { e.stopPropagation(); closeStartPanel(); }
  });
  $('#startList').addEventListener('click', async e => {
    const fav = e.target.closest('[data-startfav]');
    if (fav) {
      e.stopPropagation();
      const p = proj(fav.dataset.startfav); if (!p) return;
      p.fav = !p.fav; renderStartList();
      await api.invoke('project:fav', p.id, p.fav).catch(() => {});
      if (!$('#startPanel').hidden) renderStartList();
      return;
    }
    const more = e.target.closest('[data-startmore]');
    if (more) { e.stopPropagation(); const m = $('#newMenu'); m.dataset.for = 'start' + more.dataset.startmore; openNewMenu(more, more.dataset.startmore, true); return; }
    const row = e.target.closest('[data-start]');
    if (row) { closeStartPanel(); openTerminal({ kind: 'claude', projectId: row.dataset.start }); }
  });
  $('#skinBtn').onclick = () => { const m = $('#skinMenu'); renderSkinMenu(); m.hidden = !m.hidden; };
  $('#bellBtn').onclick = () => { const p = $('#pop'); p.hidden = !p.hidden; if (!p.hidden) { S.unread = 0; S.notifs.forEach(n => { n.unread = false; }); renderPop(); renderStatus(); } };
  $('#clearN').onclick = () => { S.notifs = []; renderPop(); };
  $('#notifSettings').onclick = () => openSettings('bildirim');
  // links inside the markdown view: web links open in the browser, relative links open the file here
  $('#mdView').addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { window.open(href); return; }
    if (href.startsWith('#')) { const t = $('#mdView').querySelector(`[id="${CSS.escape(href.slice(1))}"]`); if (t) t.scrollIntoView({ behavior: 'smooth' }); return; }
    openFile(resolveRel($('#mdView').dataset.file, decodeURI(href.split('#')[0])));
  });
  $('#ideProjSel').addEventListener('change', e => { if (e.target.value) switchIdeProject(e.target.value); });
  const setClaude = patch => setCfg({ settings: { claude: patch } }).then(() => { renderSettings(); renderStatus(); });
  document.addEventListener('change', e => {
    if (e.target.id !== 'cModel') return;
    if (e.target.value === '__custom') { $('#cModelCustom').hidden = false; $('#cModelCustom').focus(); return; }
    setClaude({ model: e.target.value });
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'cModelCustom') setCfg({ settings: { claude: { model: e.target.value.trim() } } }).then(renderStatus);
    if (e.target.id === 'cCommand') setCfg({ settings: { claude: { command: e.target.value.trim() } } }).then(renderStatus);
    if (e.target.id === 'xModel') setCfg({ settings: { codex: { model: e.target.value.trim() } } });
    if (e.target.id === 'xCommand') setCfg({ settings: { codex: { command: e.target.value.trim() } } });
  });
  // Codex settings and the default AI
  document.addEventListener('click', e => {
    const b = e.target.closest('#setBody [data-defagent],#setBody [data-xeffort],#setBody [data-xmode],#setBody [data-xset]'); if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
    const d = b.dataset, c = CFG.settings.codex || {};
    const done = () => { renderSettings(); renderStatus(); };
    if (d.defagent) setCfg({ settings: { defaultAgent: d.defagent } }).then(done);
    else if (d.xeffort !== undefined) setCfg({ settings: { codex: { effort: d.xeffort } } }).then(done);
    else if (d.xmode !== undefined) setCfg({ settings: { codex: { mode: d.xmode } } }).then(done);
    else setCfg({ settings: { codex: { [d.xset]: !c[d.xset] } } }).then(done);
  });
  // Ctrl+V in a terminal with files copied in Explorer: paste their paths (like Windows Terminal)
  document.addEventListener('paste', async e => {
    if (!e.target.closest || !e.target.closest('.xterm')) return;
    const dt = e.clipboardData;
    if (dt && dt.getData('text/plain')) return; // normal text: xterm handles it
    const t = S.tabs.find(x => x.el && x.el.contains(e.target));
    if (!t || !t.term) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const files = await api.invoke('clipboard:files').catch(() => []);
    if (files.length) t.term.paste(files.map(quotePath).join(' '));
  }, true);
  // the IDE tree: a file or folder can be dragged onto a terminal
  document.addEventListener('dragstart', e => {
    const b = e.target.closest && e.target.closest('#tree [data-file], #tree [data-dir]');
    if (!b) return;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/x-vox-path', b.dataset.file || b.dataset.dir);
  });
  // files dragged from Explorer / Finder / the IDE tree onto a terminal: type their full paths
  // (like Windows Terminal); Claude Code and Codex take a dropped image path as an attachment
  const termAt = target => target && target.closest && S.tabs.find(x => x.term && !x.exited && x.el && x.el.contains(target));
  const dragHasFiles = e => [...(e.dataTransfer && e.dataTransfer.types || [])].some(x => x === 'Files' || x === 'text/x-vox-path');
  let dropPane = null;
  const markDrop = el => { if (dropPane === el) return; if (dropPane) dropPane.classList.remove('file-drop'); dropPane = el; if (el) el.classList.add('file-drop'); };
  document.addEventListener('dragover', e => {
    const t = dragHasFiles(e) && termAt(e.target);
    if (!t) { markDrop(null); return; }
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    markDrop(t.el);
  }, true);
  document.addEventListener('dragleave', e => { if (dropPane && !dropPane.contains(e.relatedTarget)) markDrop(null); }, true);
  document.addEventListener('drop', e => {
    markDrop(null);
    const t = dragHasFiles(e) && termAt(e.target);
    if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    let paths = [...(e.dataTransfer.files || [])].map(f => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) paths = (e.dataTransfer.getData('text/x-vox-path') || '').split('\n').filter(Boolean); // from the IDE tree
    if (!paths.length) return;
    t.term.paste(paths.map(quotePath).join(' ') + ' ');
    activate(t.id);
  }, true);
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-ceffort],[data-cpm],[data-cset],[data-cleanup],[data-upd],[data-updcheck],[data-upddl],[data-updgo],[data-updpage]'); if (!b) return;
    if (b.closest('#setBody') && ('upd' in b.dataset || 'updcheck' in b.dataset || 'upddl' in b.dataset || 'updgo' in b.dataset || 'updpage' in b.dataset)) { updateAction(b.dataset); return; }
    const c = CFG.settings.claude || {};
    if (b.dataset.cleanup) {
      try { CLEANUP = await api.invoke('claude:setCleanup', Number(b.dataset.cleanup)); renderSettings(); toast(__('Oturum geçmişi'), __('Claude Code artık {n} günden eski oturumları siler.', { n: CLEANUP })); }
      catch (err) { toast(__('Ayar kaydedilemedi'), cleanErr(err)); }
      return;
    }
    if (b.dataset.ceffort !== undefined) setClaude({ effort: b.dataset.ceffort });
    else if (b.dataset.cpm !== undefined) setClaude({ permissionMode: b.dataset.cpm });
    else setClaude({ [b.dataset.cset]: !c[b.dataset.cset] });
  });
  document.addEventListener('input', e => {
    const f = e.target.dataset && e.target.dataset.field; if (!f) return;
    setCfg({ settings: { [f]: e.target.value } }).then(() => { updatePromptPreview(); if (f === 'uiLang') renderSettings(); });
    if (f === 'name') $$('[data-hitap]').forEach(b => b.classList.toggle('on', b.dataset.hitap === e.target.value.trim()));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenus(); $('#settings').hidden = true; $('#discover').hidden = true; $('#report').hidden = true; $('#wfWin').hidden = true; }
  });
  // capture phase: app shortcuts win over the terminal and the code editor
  window.addEventListener('keydown', e => {
    const combo = comboOf(e);
    const sc = SHORTCUTS.find(s => s.run && s.keys === combo && (!s.ide || ideKeysOk(e)) && (!s.when || s.when(e)));
    if (!sc) return;
    e.preventDefault(); e.stopPropagation();
    sc.run();
  }, true);
  api.on('focus-tab', id => { if (String(id).startsWith('watch:')) { const sid = id.slice(6); const w = watchTab(sid); if (w) id = w.id; else { if (isExtLive(sid)) openWatch(sid); return; } } const t = tabById(id); if (!t) return; if (S.mode === 'ide' && t.projectId !== IDE.project) switchIdeProject(t.projectId); activate(id); });
  api.on('open-settings', () => openSettings());
  api.on('win:state', st => { if (st && 'fullscreen' in st) document.documentElement.classList.toggle('is-fullscreen', !!st.fullscreen); });
  window.addEventListener('focus', () => { const t = tabById(S.active); const seen = seenTab(S.active), attn = !!(t && t.attn); if (attn) t.attn = null; if (seen || attn) renderAll(); });
  // the welcome window picked a project; take it (only once) and act on it
  api.on('open-project', async () => handleOpen(await api.invoke('app:takePendingOpen')));
  api.on('projects-changed', async list => { S.projects = list; CFG.projects = list; await refreshAllHistory(); renderAll(); });
  api.on('config-changed', c => { const skin = CFG && CFG.settings.skin, own = CFG && JSON.stringify(CFG.settings.customThemes || []); CFG = c; if (c.settings.skin !== skin || JSON.stringify(c.settings.customThemes || []) !== own) applySkin(c.settings.skin); renderSettings(); renderStatus(); });
  $('#updBtn').onclick = () => openSettings('hakkinda');
  api.invoke('update:state').then(st => { UPD = st; renderUpdBtn(); }).catch(() => {});
  api.on('address-learned', n => toast(__('Hitap güncellendi'), n ? __('Bundan sonra “{name}” diye hitap edilecek.', { name: n }) : __('Bundan sonra hitap kullanılmayacak.')));
  window.addEventListener('beforeunload', e => {
    if (Object.keys(IDE.files).some(isDirty)) { e.returnValue = false; }
  });
}
function toolbar(a) {
  const cm = IDE.cm;
  const f = IDE.files[ist().file], text = !!(f && f.doc);
  if (a === 'new') newEntry(projRoot(), false);
  else if (a === 'quick') openPalette('');
  else if (a === 'psearch') openProjectSearch();
  else if (a === 'save') saveFile();
  else if (a === 'saveall') {
    const list = ist().tabs.filter(isDirty);
    Promise.all(list.map(fp => saveFile(fp))).then(r => { const n = r.filter(Boolean).length; if (n) toast(__('Kaydedildi'), __('{n} dosya', { n })); });
  }
  else if (a === 'undo') { if (text) { cm.undo(); cm.focus(); } }
  else if (a === 'redo') { if (text) { cm.redo(); cm.focus(); } }
  else if (a === 'smaller') { IDE.ui.size = Math.max(10, IDE.ui.size - 1); saveIdeUi(); }
  else if (a === 'bigger') { IDE.ui.size = Math.min(22, IDE.ui.size + 1); saveIdeUi(); }
  else if (a === 'ex') { IDE.ui.ex = !IDE.ui.ex; saveIdeUi(); }
  else if (a === 'panel') { IDE.ui.panel = !IDE.ui.panel; saveIdeUi(); }
  else if (a === 'dock') { IDE.ui.dock = IDE.ui.dock === 'right' ? 'bottom' : 'right'; IDE.ui.panel = true; saveIdeUi(); }
  else if (a === 'ask') askClaude();
}

/* remember which terminals are open, so they can be restored next time */
/* rename a session: an open tab (any kind), an outside session being watched, or a past one.
   Claude sessions keep the name in their transcript, like Claude Code's /rename. */
async function renameSessionUi(el) {
  const d = el.dataset;
  const t = d.tab ? tabById(d.tab) : d.watch ? S.tabs.find(x => x.kind === 'watch' && x.sessionId === d.watch) : null;
  const sid = t ? t.sessionId : d.watch || d.resume || '';
  const pid = t ? t.projectId : d.pid;
  const ext = d.watch ? S.live.find(x => x.sessionId === d.watch) : null;
  const h = d.resume ? (S.history[pid] || []).find(x => x.id === d.resume) : null;
  const cur = t ? t.title : ext ? ext.title : h ? h.title : '';
  const isClaude = t ? t.kind !== 'shell' : true;
  const agent = (t && t.agent) || (h && h.agent) || null;
  const name = await uiPrompt({
    title: isClaude ? __('Oturumu yeniden adlandır') : __('Terminali yeniden adlandır'), icon: 'fa-i-cursor',
    input: cur, ok: __('Kaydet'), maxLength: 120,
    detail: isClaude && sid ? (agent === 'codex' ? __('Ad VoxStorm’da saklanır; Codex’in kendi listesi değişmez.') : __('Ad oturum kaydına yazılır; Claude Code’un /resume listesinde de görünür.')) : '',
  });
  const v = name == null ? '' : name.replace(/\s+/g, ' ').trim();
  if (!v || v === cur) return;
  if (t) { t.title = shorten(v, 48); t.renamed = true; }
  if (isClaude && sid) {
    const p = proj(pid);
    const r = await api.invoke('session:rename', sid, (p && p.path) || (ext && ext.cwd) || '', v, agent).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) uiAlert({ title: __('Ad kaydedilemedi'), message: r.error || __('Bilinmeyen hata.') });
    if (pid) await refreshHistory(pid);
  }
  saveOpenTabs();
  renderAll();
}
function saveOpenTabs() {
  const list = S.tabs
    .filter(t => !t.exited && (t.kind === 'shell' || (t.sessionId && t.prompted)))
    .map(t => ({ projectId: t.projectId, kind: t.kind, agent: t.agent || null, shell: t.shell || null, sessionId: t.kind === 'claude' ? t.sessionId : null, title: t.title, group: t.group || null }));
  const tabGroups = S.groups.filter(g => list.some(x => x.group === g.id));
  CFG.lastTabs = list; CFG.tabGroups = tabGroups;
  api.invoke('config:set', { lastTabs: list, tabGroups });
}
async function restoreTabs(pid) {
  const list = (CFG.lastTabs || []).filter(t => proj(t.projectId) && (!pid || t.projectId === pid));
  if (!list.length) {
    // nothing remembered: continue the most recent conversation of that project
    const h = pid && (S.history[pid] || [])[0];
    if (h) await openTerminal({ kind: 'claude', agent: h.agent, projectId: pid, resume: h.id, title: shorten(h.title, 48) });
    else toast(__('Geri yüklenecek oturum yok'));
    return;
  }
  const groupDefs = CFG.tabGroups || [];
  for (const t of list) {
    const group = restoreGroup(groupDefs.find(g => g.id === t.group));
    if (t.kind === 'shell') {
      if (S.tabs.some(x => x.projectId === t.projectId && x.shell === t.shell && !x.exited)) continue;
      await openTerminal({ kind: 'shell', shell: t.shell, projectId: t.projectId, group });
    } else await openTerminal({ kind: 'claude', agent: t.agent || undefined, projectId: t.projectId, resume: t.sessionId, title: t.title, group });
  }
  toast(__('Oturumlar geri yüklendi'), __('{n} terminal', { n: list.length }));
}

async function handleOpen(req) {
  if (req && req.action === 'restoreAll') { if (S.mode !== 'claude') setMode('claude'); await restoreTabs(null); return; }
  if (!req || !req.projectId) return;
  if (!proj(req.projectId)) {
    const r = await api.invoke('config:get');
    CFG = r.config; S.projects = CFG.projects;
    await refreshHistory(req.projectId);
  }
  const p = proj(req.projectId); if (!p) return;
  if (req.action === 'ide') {
    if (S.mode !== 'ide') setMode('ide');
    switchIdeProject(p.id);
    return;
  }
  if (S.mode !== 'claude') setMode('claude');
  S.collapsed[p.id] = false;
  renderSide();
  if (req.action === 'claude') { openTerminal({ kind: 'claude', projectId: p.id }); return; }
  if (req.action === 'restore') { await restoreTabs(p.id); return; }
  // project has no open terminal: start a new Claude session in it right away
  if (!S.tabs.some(t => t.projectId === p.id)) { await openTerminal({ kind: 'claude', projectId: p.id }); return; }
  const row = [...document.querySelectorAll('#side [data-toggle]')].find(b => b.dataset.toggle === p.id);
  if (row) {
    const box = row.closest('.proj');
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    box.classList.add('flash');
    setTimeout(() => box.classList.remove('flash'), 1600);
  }
}

/* ---------------- "Proje Başlat" panel ---------------- */
const START = { sel: 0, view: [] };
const lowerTr = s => String(s || '').toLocaleLowerCase('tr');
// a project added a moment ago counts as used then, so it is not listed last for having no sessions
function lastActivity(pid) { const h = (S.history[pid] || [])[0], p = proj(pid); return Math.max(h ? h.mtime : 0, (p && p.added) || 0); }
function openStartPanel(query) {
  if (S.mode !== 'claude') setMode('claude');
  $('#startPanel').hidden = false;
  $('#startBtn').setAttribute('aria-expanded', 'true');
  $('#startQ').value = query || '';
  START.sel = 0;
  renderStartList();
  $('#startQ').focus();
}
function closeStartPanel() {
  $('#startPanel').hidden = true;
  $('#startBtn').setAttribute('aria-expanded', 'false');
}
function renderStartList() {
  const q = lowerTr($('#startQ').value.trim());
  START.view = S.projects
    .filter(p => !q || lowerTr(p.name).includes(q) || lowerTr(p.path).includes(q))
    .sort((a, b) => (!!b.fav - !!a.fav) || lastActivity(b.id) - lastActivity(a.id)); // favourites first
  START.sel = Math.min(START.sel, Math.max(0, START.view.length - 1));
  const favs = START.view.filter(p => p.fav).length;
  const head = i => (!favs ? '' : i === 0 ? `<div class="sp-sec"><i class="fa-solid fa-star"></i> ${__('Favoriler')}</div>` : i === favs && favs < START.view.length ? `<div class="sp-sec">${__('Diğer projeler')}</div>` : '');
  $('#startList').innerHTML = START.view.length ? START.view.map((p, i) => {
    const live = S.tabs.filter(t => t.projectId === p.id).length;
    const last = lastActivity(p.id);
    return `${head(i)}<div class="sp-row ${i === START.sel ? 'sel' : ''}" data-start="${p.id}" role="option" title="${esc(p.path)}&#10;${esc(__('Tıkla: yeni Claude oturumu'))}">
      <div class="sp-info"><b>${esc(p.name)}${live ? ` <span class="sp-live">${__('{n} açık', { n: live })}</span>` : ''}</b><span>${esc(p.path)}</span></div>
      <span class="sp-time">${last ? rel(last) : ''}</span>
      <button class="sp-star ${p.fav ? 'on' : ''}" data-startfav="${p.id}" title="${esc(p.fav ? __('Favorilerden çıkar') : __('Favorilere ekle: listenin başında durur'))}" aria-label="${esc(p.fav ? __('Favorilerden çıkar') : __('Favorilere ekle'))}"><i class="fa-${p.fav ? 'solid' : 'regular'} fa-star"></i></button>
      <button class="sp-more" data-startmore="${p.id}" title="${esc(__('Diğer seçenekler: terminal, izin modu, geçmiş oturumlar'))}" aria-label="${esc(__('{name} için seçenekler', { name: p.name }))}"><i class="fa-solid fa-chevron-right"></i></button>
    </div>`;
  }).join('') : `<div class="sp-empty">${__('“{q}” ile eşleşen proje yok.', { q: esc($('#startQ').value) })}</div>`;
  const el = $('#startList .sp-row.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
}

/* ---------------- panels: see dock.js (applyPanels, togglePanel, showPanel) ---------------- */

/* ---------------- keyboard shortcuts ---------------- */
function comboOf(e) {
  let k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.code === 'Comma' ? ',' : e.key;
  // macOS: Cmd is the app's Ctrl; Control+Tab stays the tab switcher (Cmd+Tab belongs to macOS)
  const ctrl = IS_MAC ? (k === 'Tab' ? e.ctrlKey : e.metaKey) : e.ctrlKey;
  return (ctrl ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + k;
}
function projectHere() {
  const t = tabById(S.active);
  return (t && t.projectId) || (S.mode === 'ide' && IDE.project) || (S.projects[0] && S.projects[0].id);
}
function cycleTabs(dir) {
  const list = S.mode === 'ide' ? S.tabs.filter(t => t.projectId === IDE.project) : S.tabs;
  if (!list.length) return;
  const i = list.findIndex(t => t.id === S.active);
  activate(list[(i + dir + list.length) % list.length].id);
}
const SHORTCUTS = [
  { group: __('Genel'), keys: 'Ctrl+1', label: __('AI modu (Claude oturumları)'), run: () => setMode('claude') },
  { group: __('Genel'), keys: 'Ctrl+2', label: __('IDE modu'), run: () => setMode('ide') },
  { group: __('Genel'), keys: 'Ctrl+3', label: __('Veritabanı (DB) modu'), run: () => setMode('db') },
  { group: __('Genel'), keys: 'Ctrl+4', label: __('SSH modu (terminal, SFTP, RDP)'), run: () => setMode('ssh') },
  { group: __('Genel'), keys: 'Ctrl+Shift+M', label: __('Modu ayrı pencerede aç / ana pencereye geri al (mod düğmesinde sağ tık da olur)'), run: () => toggleDetach() },
  { group: __('Genel'), keys: 'Ctrl+Shift+P', label: __('Proje Başlat paneli'), run: () => showPanel('side').then(() => openStartPanel()) },
  { group: __('Genel'), keys: 'Ctrl+Shift+O', label: __('Karşılama ekranı'), run: () => api.send('app:welcome') },
  { group: __('Genel'), keys: 'Ctrl+,', label: __('Ayarlar'), run: () => openSettings() },
  { group: __('Genel'), keys: 'Ctrl+Shift+R', label: __('Aylık kullanım raporu'), run: () => openReport() },
  { group: __('Genel'), keys: 'Ctrl+Shift+G', label: __('Git / GitHub paneli'), run: () => toggleGitPanel() },
  { group: __('Genel'), keys: 'F1', label: __('Kısayol listesi'), run: () => openSettings('kisayol') },
  { group: __('Paneller'), keys: 'Ctrl+Shift+E', label: __('Sol panel (IDE: dosya gezgini)'), run: () => togglePanel('left') },
  { group: __('Paneller'), keys: 'Ctrl+Shift+D', label: __('Sağ panel (IDE: Claude paneli)'), run: () => togglePanel('right') },
  { group: __('Paneller'), keys: 'Ctrl+Shift+U', label: __('Haftalık kullanım paneli'), run: () => togglePanel('usage') },
  { group: __('Paneller'), keys: 'Ctrl+Shift+J', label: __('Aktif ajanlar bölümü'), run: () => togglePanel('agents') },
  { group: __('Terminaller'), keys: 'Ctrl+Shift+N', label: __('Yeni oturum, varsayılan yapay zekâyla (seçili proje)'), run: () => { const p = projectHere(); if (p) openTerminal({ kind: 'claude', projectId: p }); } },
  { group: __('Terminaller'), keys: 'Ctrl+Shift+X', label: __('Yeni Codex oturumu (seçili proje)'), when: () => !!(INFO && INFO.codex) && (S.mode === 'claude' || S.mode === 'ide'), run: () => { const p = projectHere(); if (!p) return; if (!INFO.codex) { toast(__('Codex CLI bulunamadı'), __('npm i -g @openai/codex ile kurabilirsin')); return; } openTerminal({ kind: 'claude', agent: 'codex', projectId: p }); } },
  { group: __('Terminaller'), keys: 'Ctrl+Shift+T', label: !IS_WIN ? __('Yeni terminal (seçili proje)') : __('Yeni PowerShell (seçili proje)'), run: () => { const p = projectHere(); if (p) openTerminal({ kind: 'shell', shell: DEFAULT_SHELL, projectId: p }); } },
  { group: __('Terminaller'), keys: 'Ctrl+Shift+W', label: __('Açık terminali kapat'), run: () => { if (S.active) closeTab(S.active); } },
  { group: __('Terminaller'), keys: 'Ctrl+Tab', label: __('Sonraki terminal'), run: () => cycleTabs(1) },
  { group: __('Terminaller'), keys: 'Ctrl+Shift+Tab', label: __('Önceki terminal'), run: () => cycleTabs(-1) },
  { group: __('Terminaller'), keys: 'Ctrl+C', label: __('Seçili metni kopyala (seçim yoksa işlemi durdurur)') },
  { group: __('Terminaller'), keys: 'Ctrl+V', label: __('Yapıştır') },
  { group: 'IDE', keys: 'Ctrl+P', label: __('Dosyaya git (hızlı aç)'), ide: true, run: () => openPalette('') },
  { group: 'IDE', keys: 'Ctrl+Shift+F', label: __('Projede ara'), ide: true, run: () => openProjectSearch() },
  { group: 'IDE', keys: 'Ctrl+G', label: __('Satıra git'), ide: true, run: () => openPalette(':') },
  { group: 'IDE', keys: 'Ctrl+W', label: __('Açık dosyayı kapat'), ide: true, run: () => { const fp = ist().file; if (fp) closeFile(fp); } },
  { group: 'IDE', keys: 'Alt+Z', label: __('Satır sarmayı aç / kapat'), ide: true, run: () => toggleWrap() },
  { group: 'IDE', keys: 'Ctrl+S', label: __('Dosyayı kaydet') },
  { group: 'IDE', keys: 'Ctrl+N', label: __('Yeni dosya'), ide: true, run: () => newEntry(projRoot(), false) },
  { group: 'IDE', keys: 'Ctrl+Shift+S', label: __('Farklı kaydet'), ide: true, run: () => imSaveAs() },
  { group: 'IDE', keys: 'Ctrl+F', label: __('Dosyada bul (Enter: sonraki, Shift+Enter: önceki)'), ide: true, run: () => imFind(false) },
  { group: 'IDE', keys: 'Ctrl+H', label: __('Bul ve değiştir'), ide: true, run: () => imFind(true) },
  { group: 'IDE', keys: 'F3 / Shift+F3', label: __('Sonrakini / öncekini bul') },
  { group: 'IDE', keys: 'F3', label: __('Sonrakini bul'), ide: true, hide: true, run: () => imFindStep(false) },
  { group: 'IDE', keys: 'Shift+F3', label: __('Öncekini bul'), ide: true, hide: true, run: () => imFindStep(true) },
  { group: 'IDE', keys: 'Alt / F10', label: __('Menü çubuğuna geç (oklarla gezin, Esc: geri dön)') },
  { group: 'IDE', keys: 'F10', label: __('Menü çubuğuna geç'), ide: true, hide: true, run: () => imFocusBar() },
  { group: 'IDE', keys: 'Ctrl+/ / Ctrl+7', label: __('Satır yorumunu aç / kapat') },
  { group: 'IDE', keys: 'Shift+Alt+A', label: __('Blok yorumunu aç / kapat') },
  { group: 'IDE', keys: 'Alt+↑ / Alt+↓', label: __('Satırı yukarı / aşağı taşı') },
  { group: 'IDE', keys: 'Shift+Alt+↑ / Shift+Alt+↓', label: __('Satırı yukarı / aşağı çoğalt') },
  { group: 'IDE', keys: 'Ctrl+Shift+K', label: __('Satırı sil') },
  { group: 'IDE', keys: 'Ctrl+J', label: __('Satırları birleştir') },
  { group: 'IDE', keys: 'Ctrl+Enter / Ctrl+Shift+Enter', label: __('Alta / üste yeni satır ekle') },
  { group: 'IDE', keys: 'Ctrl+D', label: __('Sonraki eşleşmeyi de seç (çoklu imleç)') },
  { group: 'IDE', keys: 'Ctrl+Shift+L', label: __('Tüm eşleşmeleri seç') },
  { group: 'IDE', keys: 'Ctrl+L', label: __('Satırı seç') },
  { group: 'IDE', keys: 'Ctrl+Alt+↑ / Ctrl+Alt+↓', label: __('Üste / alta imleç ekle') },
  { group: 'IDE', keys: 'Ctrl+M', label: __('Eşleşen paranteze git') },
  { group: 'IDE', keys: 'Ctrl+Q', label: __('Bulunduğu bloğu katla / aç') },
  { group: 'IDE', keys: 'Shift+Alt+F', label: __('JSON biçimlendir') },
  { group: 'IDE', keys: 'Ctrl+Z / Ctrl+Y', label: __('Geri al / yinele') },
  { group: 'IDE', keys: 'F2', label: __('Gezginde seçili öğeyi yeniden adlandır') },
  { group: 'IDE', keys: 'Delete', label: __('Gezginde seçili öğeyi Geri Dönüşüm Kutusu’na taşı') },
];

function kisayolHTML() {
  const groups = [...new Set(SHORTCUTS.map(s => s.group))];
  return groups.map(g => `<h4>${g}</h4><table class="kbd-t">${SHORTCUTS.filter(s => s.group === g && !s.hide).map(s => `<tr><td>${s.label}</td><td class="n">${s.keys.split(' / ').map(k => (IS_MAC ? [keysLabel(k)] : k.split('+')).map(x => `<kbd>${x}</kbd>`).join('+')).join(' / ')}</td></tr>`).join('')}</table>`).join('')
    + `<p class="set-note">${__('Uygulama kısayolları terminal ve kod düzenleyici açıkken de çalışır. Claude Code\'un kendi kısayolları ({keys} vb.) terminale gitmeye devam eder.', { keys: IS_MAC ? '⌃B, ⌃R, ⇧Tab' : 'Ctrl+B, Ctrl+R, Shift+Tab' })}${IS_MAC ? ' ' + __('macOS\'ta uygulama kısayolları ⌘ ile çalışır; ⌃ (Control) terminalde kalır.') : ''}</p>`;
}

/* ---------------- git / GitHub ----------------
   Title-bar button → drop-down panel (GitHub | Git tabs, project picker, last commits)
   → "Detaylar" window (changes, history, stash, diffs). Read-only. */
const GIT = { tab: 'git', pid: null, ov: null, gh: null, err: '', loading: false, token: 0, drop: { sel: 0, view: [] }, head: {}, newRepo: {}, btnTimer: null, btnAt: 0, btnPid: null };
const GW = { pid: null, view: 'history', ov: null, commits: [], more: true, sel: null, ltok: 0, dtok: 0 };
const gitProj = () => proj(GIT.pid);
const me = c => { const id = (CFG && CFG.identity) || {}; return !!((id.email && c.email && c.email.toLowerCase() === id.email.toLowerCase()) || (id.name && c.author === id.name)); };
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toLocaleUpperCase('tr') || '?';
const isoMs = s => (s ? Date.parse(s) : 0);
function avatarHTML(c) {
  if (c.claude) return `<span class="av claude" title="${esc(__('Claude ile yapıldı ({author})', { author: c.author }))}"><i class="fa-solid fa-robot"></i></span>`;
  return `<span class="av ${me(c) ? 'me' : ''}" title="${esc(c.author)} &lt;${esc(c.email)}&gt;">${esc(initials(c.author))}</span>`;
}
const whoText = c => (c.claude ? 'Claude' : me(c) ? __('Sen') : c.author);
function pushIcon(c) {
  if (c.pushed === true) return `<i class="pst on fa-solid fa-cloud" title="${esc(__('Push edildi'))}"></i>`;
  if (c.pushed === false) return `<i class="pst off fa-solid fa-arrow-up-from-bracket" title="${esc(__('Henüz push edilmedi'))}"></i>`;
  return `<i class="pst na fa-solid fa-cloud" title="${esc(__('Bu dalın uzak karşılığı (upstream) yok'))}"></i>`;
}

/* ---- title-bar button: branch + unpushed count of the project in front ---- */
function scheduleGitBtn(now) {
  clearTimeout(GIT.btnTimer);
  const pid = projectHere();
  const wait = now || pid !== GIT.btnPid ? 120 : Math.max(800, 5000 - (Date.now() - GIT.btnAt));
  GIT.btnTimer = setTimeout(updateGitBtn, wait);
}
async function updateGitBtn() {
  const pid = projectHere(), p = proj(pid);
  GIT.btnPid = pid; GIT.btnAt = Date.now();
  let h = { repo: false };
  if (p) { try { h = await api.invoke('git:head', p.path); } catch (_) {} }
  if (pid !== projectHere()) return;
  GIT.head[pid] = h;
  $('#gitBtnLabel').textContent = h.repo ? (h.detached ? 'detached' : h.branch) : 'Git';
  $('#gitBtnN').hidden = !(h.repo && h.ahead);
  $('#gitBtnN').textContent = '↑' + (h.ahead || 0);
  $('#gitBtn').title = p ? `${p.name}${h.repo ? ` · ${h.branch}${h.ahead ? ' · ' + __('{n} commit push edilmedi', { n: h.ahead }) : ''}${h.dirty ? ' · ' + __('{n} değişiklik', { n: h.dirty }) : ''}` : ' · ' + __('git deposu değil')}\n${__('Git ve GitHub (Ctrl+Shift+G)')}` : __('Git ve GitHub (Ctrl+Shift+G)');
}

/* ---- panel ---- */
function openGitPanel() {
  closeMenus(); closeStartPanel();
  GIT.pid = projectHere();
  $('#gitPanel').hidden = false;
  $('#gitBtn').setAttribute('aria-expanded', 'true');
  renderGitPanel();
  loadGit();
}
function closeGitPanel() {
  $('#gitPanel').hidden = true; closeGitDrop();
  $('#gitBtn').setAttribute('aria-expanded', 'false');
}
const toggleGitPanel = () => ($('#gitPanel').hidden ? openGitPanel() : closeGitPanel());
function setGitTab(t) {
  GIT.tab = t;
  setCfg({ settings: { gitTab: t } });
  renderGitPanel();
  loadGit();
}
async function loadGit(force) {
  const p = gitProj(); if (!p) { renderGitBody(); return; }
  const tok = ++GIT.token, tab = GIT.tab;
  GIT.loading = true; GIT.err = '';
  if (tab === 'git' && (!GIT.ov || GIT.ov._pid !== p.id)) GIT.ov = null;
  if (tab === 'github' && (!GIT.gh || GIT.gh._pid !== p.id)) GIT.gh = null;
  renderGitBody();
  try {
    if (tab === 'git') { const ov = await api.invoke('git:overview', p.path); ov._pid = p.id; if (tok === GIT.token) GIT.ov = ov; }
    else { const gh = await api.invoke('github:info', p.path, !!force); gh._pid = p.id; if (tok === GIT.token) GIT.gh = gh; }
  } catch (e) { if (tok === GIT.token) GIT.err = cleanErr(e); }
  if (tok !== GIT.token) return;
  GIT.loading = false;
  renderGitBody();
  if (tab === 'git') scheduleGitBtn(true);
}
function renderGitPanel() {
  $$('#gitPanel [data-gtab]').forEach(b => { const on = b.dataset.gtab === GIT.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  const p = gitProj();
  $('#gitProjName').textContent = p ? p.name : __('Proje seç');
  $('#gitProjPath').textContent = p ? p.path : (S.projects.length ? __('Listeden bir proje seç') : __('Henüz proje yok'));
  renderGitBody();
}
function renderGitBody() {
  const p = gitProj(), b = $('#gitBody');
  if (!p) { b.innerHTML = `<div class="gp-note"><i class="fa-regular fa-folder-open"></i>${__('Üstten bir proje seç.')}</div>`; return; }
  if (GIT.err) { b.innerHTML = `<div class="gp-note"><i class="fa-solid fa-triangle-exclamation"></i>${esc(GIT.err)}<br><button class="btn" data-gitreload>${__('Tekrar dene')}</button></div>`; return; }
  const d = GIT.tab === 'git' ? GIT.ov : GIT.gh;
  if (!d) { b.innerHTML = `<div class="gp-note"><i class="fa-solid fa-circle-notch fa-spin"></i>${__('Yükleniyor…')}</div>`; return; }
  b.innerHTML = GIT.tab === 'git' ? gitBodyHTML(d) : githubBodyHTML(d);
}
function branchLine(ov) {
  const n = ov.staged.length + ov.unstaged.length + ov.untracked.length + ov.conflicted.length;
  return `<div class="gp-branch"><i class="fa-solid fa-code-branch ic-mut"></i><b>${esc(ov.detached ? 'detached HEAD' : ov.branch)}</b>
    ${ov.upstream ? `<span class="gchip" title="${esc(__('Uzak dal'))}">→ ${esc(ov.upstream)}</span>` : `<span class="gchip warn" title="${esc(__('Bu dal henüz bir uzak dala bağlı değil'))}">${__('upstream yok')}</span>`}
    ${ov.ahead ? `<span class="gchip warn" title="${esc(__('Push edilmemiş commit'))}">↑ ${ov.ahead}</span>` : ''}
    ${ov.behind ? `<span class="gchip acc" title="${esc(__("Uzakta olup sende olmayan commit (son fetch'e göre)"))}">↓ ${ov.behind}</span>` : ''}
    ${ov.conflicted.length ? `<span class="gchip bad">${__('{n} çakışma', { n: ov.conflicted.length })}</span>` : ''}
    ${n ? `<span class="gchip acc">${__('{n} değişiklik', { n })}</span>` : `<span class="gchip ok">${__('temiz')}</span>`}
    ${ov.stashes.length ? `<span class="gchip">${__('{n} stash', { n: ov.stashes.length })}</span>` : ''}</div>`;
}
function gitBodyHTML(ov) {
  if (!ov.repo) return `<div class="gp-note"><i class="fa-brands fa-git-alt"></i>${__('Bu proje bir git deposu değil.')}</div>`;
  const rows = ov.commits.map(c => `<button class="gc" data-gitc="${c.hash}" title="${esc(c.subject)}&#10;${esc(c.author)} · ${new Date(c.at).toLocaleString(I18N.locale())}">
      ${avatarHTML(c)}<span class="gc-tx"><b>${esc(c.subject)}</b><span>${esc(whoText(c))} · ${rel(c.at)} · <code>${c.short}</code></span></span>${pushIcon(c)}</button>`).join('');
  return branchLine(ov) +
    `<div class="gp-h">${__('Son commitler')} <button class="ghost" data-gitreload title="${esc(__('Yenile'))}"><i class="fa-solid fa-arrows-rotate"></i></button></div>` +
    (rows || `<div class="gp-note">${__('Henüz commit yok.')}</div>`) +
    `<button class="gp-detail-btn" data-gwopen="changes"><i class="fa-solid fa-up-right-from-square"></i>${__('Detaylar')} <small>${__('değişiklikler, stash, geçmiş')}</small></button>`;
}
function runIcon(r) {
  if (r.status !== 'completed') return `<i class="fa-solid fa-circle-notch fa-spin ic-run" title="${esc(__('Çalışıyor'))}"></i>`;
  if (r.conclusion === 'success') return `<i class="fa-solid fa-circle-check ic-ok" title="${esc(__('Başarılı'))}"></i>`;
  if (r.conclusion === 'failure' || r.conclusion === 'timed_out') return `<i class="fa-solid fa-circle-xmark ic-bad" title="${esc(__('Başarısız'))}"></i>`;
  return `<i class="fa-solid fa-ban ic-mut" title="${esc(r.conclusion || '')}"></i>`;
}
/* ---- no GitHub repo yet: create one with Claude, or on github.com and connect it here ---- */
const repoSlug = n => String(n || '').replace(/ı/g, 'i').replace(/İ/g, 'I').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'proje';
const newRepo = pid => GIT.newRepo[pid] || (GIT.newRepo[pid] = { name: repoSlug((proj(pid) || {}).name), vis: 'private', opened: false });
function newRepoHTML(g) {
  if (g.remote) return `<div class="gp-note"><i class="fa-brands fa-github"></i>${__("Bu projenin uzak deposu GitHub'da değil.")}<br><code>${esc(g.remote)}</code></div>`;
  const r = newRepo(GIT.pid);
  return `<div class="nr">
    <div class="nr-h"><i class="fa-brands fa-github"></i><span>${__('Bu projenin GitHub deposu yok.')}<small>${__('Yeni bir depo oluşturup bu projeye bağlayabilirsin.')}</small></span></div>
    <label class="nr-l">${__('Depo adı')}<input id="nrName" value="${esc(r.name)}" spellcheck="false" autocomplete="off"></label>
    <div class="nr-vis" role="radiogroup" aria-label="${esc(__('Görünürlük'))}">
      <button class="${r.vis === 'private' ? 'on' : ''}" data-nrvis="private" role="radio" aria-checked="${r.vis === 'private'}"><i class="fa-solid fa-lock"></i>${__('Özel')}</button>
      <button class="${r.vis === 'public' ? 'on' : ''}" data-nrvis="public" role="radio" aria-checked="${r.vis === 'public'}"><i class="fa-solid fa-globe"></i>${__('Herkese açık')}</button>
    </div>
    <button class="nr-opt" data-nrclaude><i class="fa-solid fa-robot"></i><span><b>${__("Claude ile GitHub'da oluştur")}</b><small>${__('Yeni bir Claude oturumu git init, .gitignore, ilk commit, depo oluşturma ve push işlerini yapar.')}</small></span></button>
    <button class="nr-opt" data-nrweb><i class="fa-brands fa-github"></i><span><b>${__('GitHub üzerinden oluştur')}</b><small>${__('github.com/new bu bilgilerle açılır. Oluşturunca adresini aşağıya yapıştır.')}</small></span></button>
    <div class="nr-con ${r.opened ? 'hl' : ''}">
      <span>${__('Depoyu oluşturduysan adresini yapıştır, bu projeye bağlayayım:')}</span>
      <div class="nr-row"><input id="nrUrl" placeholder="${esc(__('https://github.com/kullanici/{name}', { name: r.name }))}" spellcheck="false" autocomplete="off"><button class="btn primary" data-nrconnect>${__('Bağla')}</button></div>
    </div>
  </div>`;
}
async function createWithClaude() {
  const p = gitProj(); if (!p) return;
  const r = newRepo(p.id);
  r.name = repoSlug(r.name);
  const prompt = __('Bu projeyi GitHub\'a yeni bir depo olarak yükle. Depo adı: "{name}", görünürlük: {vis}. Adımlar: 1) Klasör git deposu değilse git init yap, dal adı main olsun. 2) Uygun bir .gitignore yoksa projeye göre oluştur; .env, anahtar ve parola gibi gizli dosyalar kesinlikle commit edilmesin. 3) Commit edilmemiş dosyalar varsa ilk commit\'i at. 4) GitHub\'da depoyu oluştur: gh CLI kurulu ve giriş yapılmışsa gh repo create kullan; değilse dur ve bana nasıl ilerleyeceğimizi sor. 5) Depoyu origin olarak ekle ve push et. Başlamadan önce yapacaklarını kısaca listele.',
    { name: r.name, vis: r.vis === 'private' ? __('özel (private)') : __('herkese açık (public)') });
  closeGitPanel();
  const t = await openTerminal({ kind: 'claude', projectId: p.id, title: __('GitHub deposu oluştur') });
  if (!t) return;
  t.pendingPrompt = prompt;
  setTimeout(() => sendPendingPrompt(t), 12000); // in case the start event never arrives
}
// type the prompt once Claude Code is up (SessionStart hook), then press Enter
function sendPendingPrompt(t) {
  const text = t.pendingPrompt; if (!text) return;
  t.pendingPrompt = null;
  setTimeout(() => {
    if (t.exited) return;
    api.send('pty:write', t.id, text);
    setTimeout(() => { if (!t.exited) api.send('pty:write', t.id, '\r'); }, 400);
  }, 800);
}
function createOnWeb() {
  const p = gitProj(); if (!p) return;
  const r = newRepo(p.id);
  r.name = repoSlug(r.name);
  r.opened = true;
  api.invoke('shell:openGithub', `https://github.com/new?name=${encodeURIComponent(r.name)}&visibility=${r.vis}`);
  renderGitBody();
  const u = $('#nrUrl'); if (u) u.focus();
}
async function connectRepo() {
  const p = gitProj(), u = $('#nrUrl'); if (!p || !u) return;
  const url = u.value.trim();
  if (!url) { u.focus(); return; }
  const btn = $('[data-nrconnect]'); btn.disabled = true; btn.textContent = __('Bağlanıyor…');
  try {
    const r = await api.invoke('git:connect', p.path, url);
    toast(__("{name} GitHub'a bağlandı", { name: p.name }), (r.initialized ? __('Git deposu oluşturuldu.') + ' ' : '') + (r.pushed ? __('Commitler gönderildi.') : __('Henüz commit yok; ilk commit\'ten sonra Push ile gönderebilirsin.')));
    delete GIT.newRepo[p.id];
    GIT.gh = null; GIT.ov = null;
    loadGit(true);
    if (SYNC[p.id]) { SYNC[p.id].fetchedAt = 0; refreshSync(p.id); }
    scheduleGitBtn(true);
  } catch (e) {
    toast(__('Bağlanamadı'), cleanErr(e));
    btn.disabled = false; btn.textContent = __('Bağla');
  }
}
function githubBodyHTML(g) {
  if (!g.github) return newRepoHTML(g);
  const open = `<button class="btn" data-ghurl="${esc(g.github.url)}"><i class="fa-brands fa-github"></i> ${__("GitHub'da aç")}</button>`;
  const foot = `<div class="gh-foot"><span>${g.via === 'gh' ? `<i class="fa-solid fa-key"></i> GitHub CLI${g.login ? ' · ' + esc(g.login) : ''}` : `<i class="fa-solid fa-globe"></i> ${__('Herkese açık API (özel depolar görünmez)')}`}</span><button class="ghost" data-gitreload="force"><i class="fa-solid fa-arrows-rotate"></i> ${__('Yenile')}</button></div>`;
  if (!g.repo) {
    const why = g.limited ? __('GitHub API sınırına ulaşıldı (saatte 60 istek). GitHub CLI (gh) ile giriş yaparsan sınır kalkar.')
      : g.repoStatus === 404 ? __('Depo bulunamadı ya da özel. Özel depoları görmek için GitHub CLI (gh) kurup <code>gh auth login</code> ile giriş yap.')
      : esc(g.repoError || __('GitHub\'a ulaşılamadı.'));
    return `<div class="gp-note"><i class="fa-brands fa-github"></i><b>${esc(g.github.owner + '/' + g.github.repo)}</b><br>${why}<br>${open}</div>` + foot;
  }
  const r = g.repo;
  const list = (title, items, row, empty) => `<div class="gp-h">${title}</div>` + (items.length ? items.map(row).join('') : `<div class="gp-note" style="padding:6px">${empty}</div>`);
  return `<div class="gh-card">
      <button class="gh-link" data-ghurl="${esc(r.url)}">${r.private ? '<i class="fa-solid fa-lock ic-mut"></i> ' : ''}${esc(r.fullName)}</button>
      ${r.description ? `<p>${esc(r.description)}</p>` : '<p></p>'}
      <div class="gh-stats"><span><i class="fa-regular fa-star"></i>${r.stars}</span><span><i class="fa-solid fa-code-fork"></i>${r.forks}</span><span><i class="fa-solid fa-code-branch"></i>${esc(r.defaultBranch)}</span>${r.language ? `<span><i class="fa-solid fa-circle ic-acc" style="font-size:8px"></i>${esc(r.language)}</span>` : ''}${r.pushedAt ? `<span><i class="fa-regular fa-clock"></i>${__('son push {time}', { time: rel(isoMs(r.pushedAt)) })}</span>` : ''}</div>
    </div>` +
    list(`${__("Açık pull request'ler")}${g.pulls.length ? ` (${g.pulls.length})` : ''}`, g.pulls, x => `<button class="gh-row" data-ghurl="${esc(x.url)}" title="${esc(x.title)}"><i class="fa-solid fa-code-pull-request ${x.draft ? 'ic-mut' : 'ic-ok'}"></i><span class="gc-tx"><b>${esc(x.title)}</b><span>#${x.n} · ${esc(x.user)}${x.branch ? ' · ' + esc(x.branch) : ''}${x.draft ? ' · ' + __('taslak') : ''}</span></span><time>${rel(isoMs(x.at))}</time></button>`, __('Açık pull request yok.')) +
    list(__('Açık issue\'lar'), g.issues, x => `<button class="gh-row" data-ghurl="${esc(x.url)}" title="${esc(x.title)}"><i class="fa-regular fa-circle-dot ic-ok"></i><span class="gc-tx"><b>${esc(x.title)}</b><span>#${x.n} · ${esc(x.user)}${x.comments ? ' · ' + __('{n} yorum', { n: x.comments }) : ''}</span></span><time>${rel(isoMs(x.at))}</time></button>`, __('Açık issue yok.')) +
    list('Actions', g.runs, x => `<button class="gh-row" data-ghurl="${esc(x.url)}" title="${esc(x.title)}">${runIcon(x)}<span class="gc-tx"><b>${esc(x.name)}</b><span>${esc(x.title)} · ${esc(x.branch || '')}</span></span><time>${rel(isoMs(x.at))}</time></button>`, __('Workflow çalışması yok.')) +
    `<div style="margin-top:10px">${open}</div>` + foot;
}

/* ---- project picker ---- */
function openGitDrop() {
  $('#gitProjDrop').hidden = false; $('#gitProjBtn').setAttribute('aria-expanded', 'true');
  $('#gitProjQ').value = ''; GIT.drop.sel = Math.max(0, S.projects.findIndex(p => p.id === GIT.pid));
  renderGitDrop(true); $('#gitProjQ').focus();
}
function closeGitDrop() { $('#gitProjDrop').hidden = true; $('#gitProjBtn').setAttribute('aria-expanded', 'false'); }
function renderGitDrop(keepOrder) {
  const q = lowerTr($('#gitProjQ').value.trim());
  GIT.drop.view = S.projects.filter(p => !q || lowerTr(p.name).includes(q) || lowerTr(p.path).includes(q));
  if (!keepOrder) GIT.drop.sel = 0;
  GIT.drop.sel = Math.min(GIT.drop.sel, Math.max(0, GIT.drop.view.length - 1));
  $('#gitProjList').innerHTML = GIT.drop.view.length ? GIT.drop.view.map((p, i) => {
    const tabs = S.tabs.filter(t => t.projectId === p.id).length;
    return `<div class="sp-row ${i === GIT.drop.sel ? 'sel' : ''}" data-gitproj="${p.id}" role="option" aria-selected="${p.id === GIT.pid}" title="${esc(p.path)}">
      <div class="sp-info"><b>${esc(p.name)}${tabs ? ` <span class="sp-live">${__('{n} açık', { n: tabs })}</span>` : ''}</b><span>${esc(p.path)}</span></div>
      <span class="ck">${p.id === GIT.pid ? '<i class="fa-solid fa-check"></i>' : ''}</span></div>`;
  }).join('') : `<div class="sp-empty">${__('“{q}” ile eşleşen proje yok.', { q: esc($('#gitProjQ').value) })}</div>`;
  const el = $('#gitProjList .sp-row.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
}
function pickGitProject(pid) {
  closeGitDrop();
  if (pid === GIT.pid) return;
  GIT.pid = pid; GIT.ov = null; GIT.gh = null;
  renderGitPanel(); loadGit();
}

/* ---- details window ---- */
async function openGitWin(view, hash) {
  const p = gitProj(); if (!p) return;
  const fresh = GW.pid !== p.id;
  Object.assign(GW, { pid: p.id, view: view || GW.view, sel: hash ? { type: 'commit', hash } : (fresh ? null : GW.sel) });
  if (fresh) { GW.commits = []; GW.more = true; GW.ov = GIT.ov && GIT.ov._pid === p.id ? GIT.ov : null; }
  closeGitPanel();
  $('#gitWin').hidden = false;
  renderGw();
  await reloadGw(!GW.ov || !fresh);
  if (GW.sel) showGwDetail();
}
async function reloadGw(withOverview) {
  const p = proj(GW.pid); if (!p) return;
  const tok = ++GW.ltok;
  try {
    const [ov, log] = await Promise.all([
      withOverview || !GW.ov ? api.invoke('git:overview', p.path) : Promise.resolve(GW.ov),
      api.invoke('git:log', p.path, 0, 60).catch(() => []),
    ]);
    if (tok !== GW.ltok) return;
    ov._pid = p.id; GW.ov = ov; GW.commits = log; GW.more = log.length === 60;
  } catch (e) { if (tok === GW.ltok) toast(__('Git okunamadı'), cleanErr(e)); }
  renderGw();
}
async function moreGwHistory() {
  const p = proj(GW.pid); if (!p) return;
  const more = await api.invoke('git:log', p.path, GW.commits.length, 100).catch(() => []);
  GW.commits = GW.commits.concat(more); GW.more = more.length === 100;
  renderGwList();
}
function renderGw() {
  const p = proj(GW.pid), ov = GW.ov;
  $('#gwTitle').innerHTML = `<i class="fa-brands fa-git-alt" style="color:#f05133"></i>${esc(p ? p.name : '')}${ov && ov.repo ? ` <small><i class="fa-solid fa-code-branch"></i> ${esc(ov.branch)}</small>` : ''}`;
  const n = ov && ov.repo ? ov.staged.length + ov.unstaged.length + ov.untracked.length + ov.conflicted.length : 0;
  const tabs = [['changes', 'fa-solid fa-file-pen', __('Değişiklikler'), n], ['history', 'fa-solid fa-clock-rotate-left', __('Geçmiş'), ''], ['stash', 'fa-solid fa-box-archive', 'Stash', ov && ov.repo ? ov.stashes.length : '']];
  $('#gwNav').innerHTML = tabs.map(([k, ic, label, c]) => `<button class="set-tab ${GW.view === k ? 'on' : ''}" data-gwview="${k}"><i class="${ic}" style="width:18px"></i> ${label}${c !== '' ? `<span class="n">${c}</span>` : ''}</button>`).join('') +
    (ov && ov.repo ? `<div style="padding:12px 10px 0;font-size:11.5px;color:var(--muted);display:grid;gap:6px">${branchLine(ov).replace('gp-branch', 'gp-branch" style="flex-direction:column;align-items:flex-start')}</div>` : '');
  renderGwList();
  if (!GW.sel) $('#gwDetail').innerHTML = `<div class="gw-empty"><i class="fa-regular fa-hand-pointer"></i>${GW.view === 'changes' ? __('Soldan bir dosya seç.') : GW.view === 'stash' ? __('Soldan bir stash seç.') : __('Soldan bir commit seç.')}</div>`;
}
const dayLabel = ms => new Date(ms).toLocaleDateString(I18N.locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
function renderGwList() {
  const ov = GW.ov, el = $('#gwList');
  if (!ov) { el.innerHTML = `<div class="gw-empty"><i class="fa-solid fa-circle-notch fa-spin"></i>${__('Yükleniyor…')}</div>`; return; }
  if (!ov.repo) { el.innerHTML = `<div class="gw-empty"><i class="fa-brands fa-git-alt"></i>${__('Bu proje bir git deposu değil.')}</div>`; return; }
  const sel = GW.sel || {};
  if (GW.view === 'changes') {
    const grp = (title, kind, files) => files.length ? `<div class="gw-grp"><span>${title}</span><span>${files.length}</span></div>` + files.map(f => {
      const on = sel.type === 'file' && sel.kind === kind && sel.path === f.path;
      return `<button class="gf ${on ? 'on' : ''}" data-gwfile="${esc(f.path)}" data-kind="${kind}" title="${esc(f.from ? f.from + ' → ' + f.path : f.path)}"><span class="fcode ${f.code === '?' ? 'Q' : esc(f.code)}">${f.code === '?' ? 'U' : esc(f.code)}</span><span class="fp"><bdi>${esc(f.path)}</bdi></span><span></span></button>`;
    }).join('') : '';
    const html = grp(__('Çakışmalar'), 'unstaged', ov.conflicted) + grp(__('Hazırlanan (staged)'), 'staged', ov.staged) + grp(__('Hazırlanmayan'), 'unstaged', ov.unstaged) + grp(__('Takip edilmeyen'), 'untracked', ov.untracked);
    el.innerHTML = html || `<div class="gw-empty"><i class="fa-solid fa-check"></i>${__('Çalışma ağacı temiz, bekleyen değişiklik yok.')}</div>`;
  } else if (GW.view === 'stash') {
    el.innerHTML = ov.stashes.length ? ov.stashes.map(s => `<button class="gw-c ${sel.type === 'stash' && sel.ref === s.ref ? 'on' : ''}" data-gwstash="${esc(s.ref)}"><span class="av"><i class="fa-solid fa-box-archive"></i></span><span class="gc-tx"><b>${esc(s.msg)}</b><span>${esc(s.ref)} · ${rel(s.at)}</span></span><span></span></button>`).join('')
      : `<div class="gw-empty"><i class="fa-solid fa-box-open"></i>${__('Stash yok.')}</div>`;
  } else {
    let day = '', html = '';
    for (const c of GW.commits) {
      const d = dayLabel(c.at);
      if (d !== day) { day = d; html += `<div class="gw-day"><i class="fa-solid fa-code-commit"></i>${esc(d)}</div>`; }
      html += `<button class="gw-c ${sel.type === 'commit' && sel.hash === c.hash ? 'on' : ''}" data-gwc="${c.hash}" title="${esc(c.subject)}">${avatarHTML(c)}<span class="gc-tx"><b>${esc(c.subject)}</b><span>${esc(whoText(c))} · ${rel(c.at)} · <code>${c.short}</code></span></span>${pushIcon(c)}</button>`;
    }
    el.innerHTML = (html || `<div class="gw-empty"><i class="fa-solid fa-code-commit"></i>${__('Henüz commit yok.')}</div>`) + (GW.more && GW.commits.length ? `<button class="btn gw-more" data-gwmore>${__('Daha eski commitler')}</button>` : '');
  }
}
async function showGwDetail() {
  const p = proj(GW.pid), s = GW.sel, box = $('#gwDetail'); if (!p || !s) return;
  const tok = ++GW.dtok;
  box.innerHTML = `<div class="gw-empty"><i class="fa-solid fa-circle-notch fa-spin"></i>${__('Yükleniyor…')}</div>`;
  try {
    if (s.type === 'commit') {
      const c = await api.invoke('git:show', p.path, s.hash);
      if (tok !== GW.dtok) return;
      const add = c.files.reduce((n, f) => n + (f.add || 0), 0), del = c.files.reduce((n, f) => n + (f.del || 0), 0);
      box.innerHTML = `<div class="gw-ch"><h3>${esc(c.subject)}</h3>${c.body ? `<pre>${esc(c.body)}</pre>` : ''}
        <div class="gw-meta"><span class="who">${avatarHTML(c)}${esc(c.author)}</span><span>${new Date(c.at).toLocaleString(I18N.locale(), { dateStyle: 'long', timeStyle: 'short' })}</span>
        <code title="${esc(__('Tam hash: {hash}', { hash: c.hash }))}">${c.short}</code>${c.parents.length ? `<span>${__('üst: {list}', { list: c.parents.map(h => `<code>${h.slice(0, 7)}</code>`).join(' ') })}</span>` : ''}
        ${c.claude ? `<span class="gchip acc"><i class="fa-solid fa-robot"></i> ${__('Claude ile')}</span>` : ''}
        ${c.pushed === true ? `<span class="gchip ok"><i class="fa-solid fa-cloud"></i> ${__('push edildi')}</span>` : c.pushed === false ? `<span class="gchip warn"><i class="fa-solid fa-arrow-up-from-bracket"></i> ${__('push edilmedi')}</span>` : ''}
        ${c.refs ? `<span class="gchip">${esc(c.refs)}</span>` : ''}</div></div>
        <div class="gw-files">${__('{n} dosya değişti', { n: c.files.length })} · <span class="nums"><span class="a">+${add}</span><span class="d">−${del}</span></span></div>` + diffHTML(c.patch);
    } else if (s.type === 'stash') {
      const r = await api.invoke('git:stash', p.path, s.ref);
      if (tok !== GW.dtok) return;
      const st = (GW.ov.stashes || []).find(x => x.ref === s.ref) || {};
      box.innerHTML = `<div class="gw-ch"><h3>${esc(st.msg || s.ref)}</h3><div class="gw-meta"><code>${esc(s.ref)}</code>${st.at ? `<span>${new Date(st.at).toLocaleString(I18N.locale(), { dateStyle: 'long', timeStyle: 'short' })}</span>` : ''}</div></div>
        <div class="gw-files">${__('{n} dosya', { n: r.files.length })}</div>` + diffHTML(r.patch);
    } else {
      const r = await api.invoke('git:diff', p.path, s.kind, s.path);
      if (tok !== GW.dtok) return;
      const head = `<div class="gw-ch"><h3 style="font:600 14px var(--f-mono)">${esc(s.path)}</h3><div class="gw-meta">${{ staged: __('Hazırlanan değişiklik (staged)'), unstaged: __('Hazırlanmayan değişiklik'), untracked: __('Yeni dosya, git takip etmiyor') }[s.kind]}</div></div>`;
      if (r.untracked) {
        box.innerHTML = head + (r.dir ? `<div class="diff-note">${__('Klasör.')}</div>` : r.binary ? `<div class="diff-note">${__('İkili (binary) dosya.')}</div>` : r.big ? `<div class="diff-note">${__('Dosya çok büyük (2 MB üstü).')}</div>`
          : fileBlock({ path: s.path, lines: r.text.replace(/\r?\n$/, '').split(/\r?\n/).map((l, i) => ({ t: 'add', n: i + 1, text: l })), add: r.text.split(/\r?\n/).length, del: 0 }));
      } else box.innerHTML = head + (r.patch.text.trim() ? diffHTML(r.patch) : `<div class="diff-note">${__('Fark yok (yalnızca izin ya da satır sonu değişmiş olabilir).')}</div>`);
    }
  } catch (e) { if (tok === GW.dtok) box.innerHTML = `<div class="gw-empty"><i class="fa-solid fa-triangle-exclamation"></i>${esc(cleanErr(e))}</div>`; }
}

/* unified diff → per-file blocks with old/new line numbers */
function parseDiff(text) {
  const files = []; let f = null, o = 0, n = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      f = { path: m ? m[2] : line.slice(11), from: m ? m[1] : '', lines: [], add: 0, del: 0, note: '' };
      files.push(f); continue;
    }
    if (!f) continue;
    if (line.startsWith('@@')) { const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/); if (m) { o = +m[1]; n = +m[2]; } f.lines.push({ t: 'hunk', text: line }); continue; }
    if (!f.lines.length) {
      if (line.startsWith('Binary files')) f.note = __('İkili (binary) dosya değişti.');
      else if (line.startsWith('new file')) f.state = __('yeni');
      else if (line.startsWith('deleted file')) f.state = __('silindi');
      else if (line.startsWith('rename from')) f.state = __('yeniden adlandırıldı');
      continue;
    }
    if (line[0] === '+') { f.lines.push({ t: 'add', n: n++, text: line.slice(1) }); f.add++; }
    else if (line[0] === '-') { f.lines.push({ t: 'del', o: o++, text: line.slice(1) }); f.del++; }
    else if (line[0] === ' ') f.lines.push({ t: 'ctx', o: o++, n: n++, text: line.slice(1) });
    else if (line[0] === '\\') f.lines.push({ t: 'ctx', text: line });
  }
  return files;
}
const MAX_DIFF_LINES = 4000;
function fileBlock(f, fold) {
  const rows = f.lines.slice(0, MAX_DIFF_LINES).map(l => l.t === 'hunk'
    ? `<tr class="hunk"><td class="ln"></td><td class="ln"></td><td>${esc(l.text)}</td></tr>`
    : `<tr class="${l.t}"><td class="ln">${l.o || ''}</td><td class="ln">${l.n || ''}</td><td>${l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}${esc(l.text.replace(/\r$/, ''))}</td></tr>`).join('');
  const rest = f.lines.length > MAX_DIFF_LINES ? `<div class="diff-note">${__('… {n} satır daha gösterilmedi.', { n: f.lines.length - MAX_DIFF_LINES })}</div>` : '';
  return `<div class="df ${fold ? 'fold' : ''}"><div class="df-h" data-dffold><i class="fa-solid fa-chevron-down"></i><span class="fp" title="${esc(f.from && f.from !== f.path ? f.from + ' → ' + f.path : f.path)}">${esc(f.from && f.from !== f.path ? f.from + ' → ' + f.path : f.path)}</span>${f.state ? `<span class="gchip">${f.state}</span>` : ''}<span class="nums"><span class="a">+${f.add}</span><span class="d">−${f.del}</span></span></div>` +
    (f.note ? `<div class="diff-note">${f.note}</div>` : f.lines.length ? `<table class="diff">${rows}</table>${rest}` : `<div class="diff-note">${__('İçerik değişmedi.')}</div>`) + '</div>';
}
function diffHTML(patch) {
  const files = parseDiff(patch.text);
  const big = files.length > 25;
  return files.map(f => fileBlock(f, big || f.lines.length > 800)).join('') + (patch.truncated ? `<div class="diff-note">${__('Fark çok büyük, bir kısmı gösterilmedi.')}</div>` : '');
}

/* ---- git line under each open project in the side panel: behind / waiting / one-click pull, push ---- */
const SYNC = {}; // pid -> { h, at, fetchedAt, busy, err, loading }
const SYNC_TEXT = { fetch: __('Kontrol ediliyor'), pull: __('Pull yapılıyor'), push: __('Push yapılıyor') };
const sideProjects = () => S.projects.filter(p => S.tabs.some(t => t.projectId === p.id) || outsideOf(p.id).length);
const syncBtn = (pid, act, icon, label, title) => `<button class="pg-act" data-gsync="${pid}" data-act="${act}" title="${esc(title)}"><i class="fa-solid ${icon}"></i>${label}</button>`;
function syncLineHTML(p) {
  const s = SYNC[p.id];
  if (!s) { refreshSync(p.id); return ''; }
  const h = s.h;
  if (!h || !h.repo) return '';
  const remotes = h.remotes || [];
  const chips = [];
  if (!remotes.length) chips.push(`<span class="gchip" title="${esc(__('Bu deponun uzak bağlantısı (remote) yok'))}">${__('yalnızca yerel')}</span>`);
  else if (!h.upstream && !h.detached) chips.push(`<span class="gchip warn" title="${esc(__('Bu dal henüz uzağa gönderilmedi'))}">${__('yayımlanmamış')}</span>`);
  if (h.behind) chips.push(`<span class="gchip acc" title="${esc(__('Uzakta olup sende olmayan {n} commit var. Pull yapman lazım.', { n: h.behind }))}">${__('↓ {n} geride', { n: h.behind })}</span>`);
  if (h.ahead) chips.push(`<span class="gchip warn" title="${esc(__('{n} commit push edilmeyi bekliyor', { n: h.ahead }))}">${__('↑ {n} bekliyor', { n: h.ahead })}</span>`);
  if (h.dirty) chips.push(`<span class="gchip" title="${esc(__('Commit edilmemiş {n} değişiklik', { n: h.dirty }))}">${__('{n} değişiklik', { n: h.dirty })}</span>`);
  if (h.upstream && !h.behind && !h.ahead) chips.push(`<span class="gchip ok" title="${esc(__('Uzak dalla aynı (son kontrole göre)'))}">${__('güncel')}</span>`);
  let act = '';
  if (s.busy) act = `<span class="pg-busy"><i class="fa-solid fa-circle-notch fa-spin"></i>${SYNC_TEXT[s.busy]}</span>`;
  else if (h.ahead && h.behind) act = `<button class="pg-act warn" data-gitopen="${p.id}" title="${esc(__('Yerel ve uzak dal ayrışmış. Otomatik birleştirme yapmıyorum; birleştirme ya da rebase gerekiyor. Ayrıntılar için tıkla.'))}"><i class="fa-solid fa-code-merge"></i>${__('Ayrışmış')}</button>`;
  else if (h.behind) act = syncBtn(p.id, 'pull', 'fa-arrow-down', 'Pull', __("{n} commit'i al (git pull --ff-only)", { n: h.behind }));
  else if (h.ahead) act = syncBtn(p.id, 'push', 'fa-arrow-up', 'Push', __("{n} commit'i gönder (git push)", { n: h.ahead }));
  else if (!h.upstream && remotes.length && !h.detached) act = syncBtn(p.id, 'push', 'fa-cloud-arrow-up', __('Yayımla'), __('{branch} dalını uzağa gönder (git push -u)', { branch: h.branch }));
  const check = s.busy || !remotes.length ? '' : `<button class="pg-ref" data-gsync="${p.id}" data-act="fetch" title="${esc(__('Uzakta yeni commit var mı bak (git fetch)'))}${s.fetchedAt ? '\n' + esc(__('Son kontrol: {time}', { time: rel(s.fetchedAt) === __('şimdi') ? __('az önce') : __('{time} önce', { time: rel(s.fetchedAt) }) })) : ''}" aria-label="${esc(__('Uzak depoyu kontrol et'))}"><i class="fa-solid fa-arrows-rotate"></i></button>`;
  const err = s.err && !s.busy ? `<i class="fa-solid fa-triangle-exclamation pg-err" title="${esc(s.err)}"></i>` : '';
  return `<div class="proj-git"><button class="pg-br" data-gitopen="${p.id}" title="${esc(h.branch)} · ${esc(__('git ayrıntıları'))}"><i class="fa-solid fa-code-branch"></i><span>${esc(h.detached ? 'detached' : h.branch)}</span></button>${chips.join('')}${err}<span class="pg-sp"></span>${act}${check}</div>`;
}
async function refreshSync(pid, doFetch) {
  const p = proj(pid); if (!p) return;
  const s = SYNC[pid] || (SYNC[pid] = { h: null, at: 0, fetchedAt: 0, busy: '', err: '', loading: false });
  if (s.loading || s.busy) return;
  s.loading = true;
  try {
    if (doFetch && s.h && s.h.repo && (s.h.remotes || []).length) {
      s.busy = 'fetch'; renderSide();
      const r = await api.invoke('git:sync', p.path, 'fetch');
      s.h = r.after; s.fetchedAt = Date.now(); s.err = '';
    } else s.h = await api.invoke('git:head', p.path);
  } catch (e) { s.err = cleanErr(e); }
  s.busy = ''; s.loading = false; s.at = Date.now();
  renderSide();
  // first time we see it: ask the remote too, so "behind" is real
  if (!doFetch && !s.fetchedAt && s.h && s.h.repo && (s.h.remotes || []).length) refreshSync(pid, true);
}
async function runSync(pid, act) {
  const p = proj(pid), s = SYNC[pid]; if (!p || !s || s.busy) return;
  if (act === 'fetch') { s.fetchedAt = 0; return refreshSync(pid, true); }
  s.busy = act; s.err = ''; renderSide();
  try {
    const r = await api.invoke('git:sync', p.path, act);
    s.h = r.after;
    const b = r.before;
    if (act === 'pull') toast(__('{name}: pull tamam', { name: p.name }), __('{n} commit alındı.', { n: b.behind }));
    else if (!b.upstream) toast(__('{name}: dal yayımlandı', { name: p.name }), __('{branch} artık uzakta da var.', { branch: b.branch }));
    else toast(__('{name}: push tamam', { name: p.name }), __('{n} commit gönderildi.', { n: b.ahead }));
  } catch (e) {
    s.err = cleanErr(e);
    toast(act === 'pull' ? __('{name}: pull yapılamadı', { name: p.name }) : __('{name}: push yapılamadı', { name: p.name }), s.err);
  }
  s.busy = '';
  renderSide();
  scheduleGitBtn(true);
  if (!$('#gitPanel').hidden && GIT.pid === pid) loadGit();
  if (!$('#gitWin').hidden && GW.pid === pid) reloadGw(true);
}
function openGitFor(pid) {
  openGitPanel();
  if (GIT.pid !== pid) pickGitProject(pid);
  if (GIT.tab !== 'git') setGitTab('git');
}

function initGit() {
  GIT.tab = (CFG.settings.gitTab === 'github') ? 'github' : 'git';
  $('#gitBtn').onclick = toggleGitPanel;
  $('#gitProjBtn').onclick = () => ($('#gitProjDrop').hidden ? openGitDrop() : closeGitDrop());
  $('#gitProjQ').addEventListener('input', () => renderGitDrop());
  $('#gitProjQ').addEventListener('keydown', e => {
    const n = GIT.drop.view.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); GIT.drop.sel = Math.min(n - 1, GIT.drop.sel + 1); renderGitDrop(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); GIT.drop.sel = Math.max(0, GIT.drop.sel - 1); renderGitDrop(true); }
    else if (e.key === 'Enter') { e.preventDefault(); const p = GIT.drop.view[GIT.drop.sel]; if (p) pickGitProject(p.id); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeGitDrop(); $('#gitProjBtn').focus(); }
  });
  $('#gitPanel').addEventListener('click', e => {
    const el = e.target.closest('[data-gtab],[data-gitproj],[data-gitc],[data-gwopen],[data-gitreload],[data-ghurl],[data-nrvis],[data-nrclaude],[data-nrweb],[data-nrconnect]'); if (!el) return;
    const d = el.dataset;
    if (d.nrvis) { newRepo(GIT.pid).vis = d.nrvis; renderGitBody(); return; }
    if (d.nrclaude !== undefined) { createWithClaude(); return; }
    if (d.nrweb !== undefined) { createOnWeb(); return; }
    if (d.nrconnect !== undefined) { connectRepo(); return; }
    if (d.gtab) { if (d.gtab !== GIT.tab) setGitTab(d.gtab); }
    else if (d.gitproj) pickGitProject(d.gitproj);
    else if (d.gitc) openGitWin('history', d.gitc);
    else if (d.gwopen) openGitWin(d.gwopen);
    else if (d.gitreload !== undefined) loadGit(d.gitreload === 'force');
    else if (d.ghurl) api.invoke('shell:openGithub', d.ghurl);
  });
  if (!$('#gitProjDrop').hidden) closeGitDrop();
  $('#gitBody').addEventListener('input', e => { if (e.target.id === 'nrName') newRepo(GIT.pid).name = e.target.value.trim(); });
  $('#gitBody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'nrUrl') { e.preventDefault(); connectRepo(); } });
  document.addEventListener('mousedown', e => {
    if (!$('#gitProjDrop').hidden && !e.target.closest('.gp-proj')) closeGitDrop();
    if (!$('#gitPanel').hidden && !e.target.closest('#gitPanel,#gitBtn')) closeGitPanel();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#gitWin').hidden) { $('#gitWin').hidden = true; return; }
    if (!$('#gitPanel').hidden) closeGitPanel();
  });
  $('#gitWin').addEventListener('click', e => {
    if (e.target.id === 'gitWin') { $('#gitWin').hidden = true; return; }
    const el = e.target.closest('[data-gwview],[data-gwc],[data-gwfile],[data-gwstash],[data-gwmore],[data-dffold]'); if (!el) return;
    const d = el.dataset;
    if (d.gwview) { GW.view = d.gwview; GW.sel = null; renderGw(); }
    else if (d.gwc) { GW.sel = { type: 'commit', hash: d.gwc }; renderGwList(); showGwDetail(); }
    else if (d.gwfile) { GW.sel = { type: 'file', kind: d.kind, path: d.gwfile }; renderGwList(); showGwDetail(); }
    else if (d.gwstash) { GW.sel = { type: 'stash', ref: d.gwstash }; renderGwList(); showGwDetail(); }
    else if (d.gwmore !== undefined) moreGwHistory();
    else if (d.dffold !== undefined) el.parentElement.classList.toggle('fold');
  });
  $('#gwClose').onclick = () => { $('#gitWin').hidden = true; };
  $('#gwRefresh').onclick = async () => { await reloadGw(true); if (GW.sel) showGwDetail(); };
  scheduleGitBtn(true);
  setInterval(() => scheduleGitBtn(true), 30000);
  setInterval(() => sideProjects().forEach(p => refreshSync(p.id)), 30000);
  setInterval(() => sideProjects().forEach(p => refreshSync(p.id, true)), 5 * 60000);
}

/* ---------------- start ---------------- */
async function init() {
  const r = await api.invoke('config:get');
  CFG = r.config; INFO = r.info;
  S.projects = CFG.projects;
  IDE.state = CFG.ide.state || {};
  IDE.ui = Object.assign({ ex: true, panel: true, size: 13, wrap: false, dock: 'bottom', ph: 260, pw: 440 }, CFG.ide.ui || {});
  applySkin(CFG.settings.skin);
  setupEditor();
  bindEvents();
  initGit();
  bindIde();
  setupIdeMenu();
  applyPanels();
  renderUsage();
  await refreshAllHistory();
  api.on('live-sessions', setLive);
  try { setLive(await api.invoke('live:list')); } catch (_) {}
  await winInit();
  setMode(['ide', 'db', 'ssh'].includes(CFG.settings.mode) ? CFG.settings.mode : 'claude', true);
  refreshUsage();
  setInterval(refreshUsage, 120000);
  setInterval(renderSide, 60000);
  setInterval(() => refreshAllHistory().then(renderSide), 180000);
  if (window.pluginHost) pluginHost.init();
  handleOpen(await api.invoke('app:takePendingOpen'));
  adoptTabs(); // terminals another window handed over while this one was starting
  if (window.whatsNew) whatsNew.maybeShow();
}
init();
