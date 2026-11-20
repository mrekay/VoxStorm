// VoxStorm — OpenAI Codex CLI sessions, next to Claude Code ones.
// A Codex tab is a terminal running `codex` (or `codex resume <id>`) with VoxStorm's hooks given on
// the command line (-c hooks.<Event>=…): every hook posts its JSON to the same local listener as
// Claude's, tagged ?agent=codex&pty=<terminal id>, so the tab learns its session id, shows
// running / waiting / done and raises the same notifications. Nothing in ~/.codex is changed.
// History comes from Codex's own thread list (state_*.sqlite: the same names `codex resume` shows),
// token usage from the rollout files in ~/.codex/sessions.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { IS_WIN, whereAll, userShell, shQuote } = require('./platform');

const CODEX_HOME = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS = () => path.join(CODEX_HOME(), 'sessions');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PreToolUse is left out: nothing needs it, and every hook costs a shell start
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
// Codex writes Windows folders as \\?\C:\…
const cleanPath = p => String(p || '').replace(/^\\\\\?\\/, '');
const samePath = (a, b) => {
  const n = p => path.resolve(cleanPath(p)).replace(/[\\/]+$/, '');
  return IS_WIN ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const splitArgs = line => { const out = []; const re = /"([^"]*)"|(\S+)/g; let m; while ((m = re.exec(String(line || '')))) out.push(m[1] !== undefined ? m[1] : m[2]); return out; };
const quoteArg = a => (/[\s"&|<>^()%]/.test(a) || a === '' ? `"${String(a).replace(/"/g, '""')}"` : a);
const toml = s => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string

module.exports = function setupCodex({ config, hookPort, buildPrompt, encodeProjectDir }) {
  const S = () => (config().settings.codex || {});

  /* ---------- finding codex ---------- */
  let found = null;
  // Windows: npm's codex.cmd runs `node …\@openai\codex\bin\codex.js`; start that directly so
  // arguments reach Codex as given, without cmd.exe's quoting rules in between
  function findCodex() {
    if (found && fs.existsSync(found.file)) return found;
    found = null;
    const all = whereAll('codex');
    if (IS_WIN) {
      for (const f of all) {
        if (/\.exe$/i.test(f)) { found = { file: f, pre: [] }; break; }
        if (!/\.cmd$/i.test(f)) continue;
        const dir = path.dirname(f);
        const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (!fs.existsSync(js)) continue;
        const node = fs.existsSync(path.join(dir, 'node.exe')) ? path.join(dir, 'node.exe') : whereAll('node').find(x => /\.exe$/i.test(x));
        if (node) { found = { file: node, pre: [js] }; break; }
      }
      if (!found) { const cmd = all.find(f => /\.cmd$/i.test(f)); if (cmd) found = { file: cmd, pre: [], line: true }; }
    } else {
      const guesses = [path.join(os.homedir(), '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.npm-global', 'bin', 'codex')];
      const f = all[0] || guesses.find(g => fs.existsSync(g));
      if (f) found = { file: f, pre: [] };
    }
    return found;
  }
  // the custom launch command from settings wins (like Claude's); otherwise codex on PATH
  function launcher() {
    const custom = splitArgs(S().command);
    if (custom.length) {
      const [head, ...rest] = custom;
      if (path.isAbsolute(head) && fs.existsSync(head) && (!IS_WIN || /\.exe$/i.test(head))) return { file: head, pre: rest };
      return { file: head, pre: rest, line: true };
    }
    return findCodex();
  }

  /* ---------- command line ---------- */
  function hookArgs(ptyId) {
    const url = `http://127.0.0.1:${hookPort()}/hook?agent=codex&pty=${encodeURIComponent(ptyId)}`;
    // Codex runs hooks through PowerShell on Windows: "@-" must be quoted there (@ starts a splat)
    const cmd = `${IS_WIN ? 'curl.exe' : 'curl'} -s -m 3 -X POST -H "Content-Type: application/json" --data-binary "@-" "${url}"`;
    const h = `[{hooks=[{type="command",command=${toml(cmd)},timeout=5,async=true}]}]`;
    return EVENTS.flatMap(ev => ['-c', `hooks.${ev}=${h}`]);
  }
  function args(opts, ptyId) {
    const s = { ...S(), ...(opts.overrides || {}) };
    const a = [];
    if (opts.resume) a.push('resume', opts.resume);
    // hooks given on the command line are new to Codex every time (the port changes): without this
    // it would skip them until the user trusts them in /hooks
    a.push('--dangerously-bypass-hook-trust', ...hookArgs(ptyId));
    if (s.model) a.push('-m', s.model);
    if (s.effort) a.push('-c', `model_reasoning_effort=${toml(s.effort)}`);
    if (s.mode === 'readonly') a.push('-s', 'read-only');
    else if (s.mode === 'never') a.push('-a', 'never');
    else if (s.mode === 'full') a.push('--dangerously-bypass-approvals-and-sandbox');
    if (s.search) a.push('--search');
    if (opts.extra) a.push(...opts.extra); // VoxStorm's MCP server (agentlink.js)
    const prompt = buildPrompt();
    if (prompt && prompt.includes('\n-')) a.push('-c', `developer_instructions=${toml(prompt)}`);
    return a;
  }
  // { file, args } for node-pty
  function launch(opts, ptyId) {
    if (opts.resume && !ID_RE.test(opts.resume)) throw new Error('Geçersiz Codex oturum kimliği.');
    const l = launcher();
    if (!l) throw new Error('codex komutu bulunamadı. Codex CLI kurulu ve PATH içinde olmalı (npm i -g @openai/codex) ya da Ayarlar → Codex oturumları → Açılış komutu doldurulmalı.');
    const all = [...l.pre, ...args(opts, ptyId)];
    if (!l.line) return { file: l.file, args: all };
    if (IS_WIN) return { file: 'cmd.exe', args: '/d /s /c "' + [quoteArg(l.file), ...all.map(quoteArg)].join(' ') + '"' };
    return { file: userShell(), args: ['-lc', 'exec ' + [l.file, ...all].map(shQuote).join(' ')] };
  }
  function summary() {
    const s = S();
    const p = [s.model || 'varsayılan model'];
    if (s.effort) p.push(s.effort + ' efor');
    if (s.mode) p.push({ readonly: 'salt okunur', never: 'sormadan', full: 'tam yetki' }[s.mode] || s.mode);
    return p.join(' · ');
  }

  /* ---------- history ---------- */
  let Sqlite = null;
  try { Sqlite = require('node:sqlite').DatabaseSync; } catch (_) {}
  function stateDb() {
    let best = null;
    try {
      for (const f of fs.readdirSync(CODEX_HOME())) {
        const m = /^state_(\d+)\.sqlite$/.exec(f);
        if (m && (!best || +m[1] > best.n)) best = { n: +m[1], f: path.join(CODEX_HOME(), f) };
      }
    } catch (_) {}
    return best && best.f;
  }
  let threadCache = null;
  function threadsFromDb() {
    if (!Sqlite) return null;
    const f = stateDb(); if (!f) return null;
    let db;
    try {
      db = new Sqlite(f, { readOnly: true });
      const cols = new Set(db.prepare('pragma table_info(threads)').all().map(c => c.name));
      if (!cols.has('id') || !cols.has('cwd')) return null;
      const pick = ['id', 'cwd', 'title', 'name', 'first_user_message', 'updated_at_ms', 'updated_at', 'source', 'archived', 'agent_role', 'attached_thread_parent_id'].filter(c => cols.has(c));
      return db.prepare(`select ${pick.join(',')} from threads`).all().filter(r =>
        !r.archived && !r.agent_role && !r.attached_thread_parent_id && (!r.source || r.source === 'cli' || r.source === 'vscode'),
      ).map(r => ({
        id: r.id, cwd: cleanPath(r.cwd),
        name: r.name || '', first: r.first_user_message || r.title || '',
        mtime: r.updated_at_ms || (r.updated_at ? r.updated_at * 1000 : 0),
      }));
    } catch (_) { return null; } finally { try { db && db.close(); } catch (_) {} }
  }
  // without the database (older Codex, no node:sqlite): the first lines of every rollout file
  const headCache = new Map();
  async function threadsFromRollouts() {
    const out = [];
    for (const f of await rollouts()) {
      let st; try { st = await fsp.stat(f); } catch (_) { continue; }
      let c = headCache.get(f);
      if (!c || c.mtime !== st.mtimeMs) {
        c = { mtime: st.mtimeMs, meta: null };
        try {
          const fh = await fsp.open(f, 'r');
          const buf = Buffer.alloc(512 * 1024);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0); await fh.close();
          let id = '', cwd = '', source = '', first = '';
          for (const line of buf.slice(0, bytesRead).toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            let o; try { o = JSON.parse(line); } catch (_) { continue; }
            const p = o.payload || {};
            if (o.type === 'session_meta') { id = p.id || p.session_id || ''; cwd = cleanPath(p.cwd); source = p.source || ''; }
            else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
              const t = (p.content || []).map(x => x && x.text || '').join(' ').trim();
              if (t && !t.startsWith('<')) { first = t; break; }
            }
          }
          if (id && (source === 'cli' || source === 'vscode')) c.meta = { id, cwd, name: '', first, mtime: st.mtimeMs };
        } catch (_) {}
        headCache.set(f, c);
      }
      if (c.meta) out.push({ ...c.meta, mtime: st.mtimeMs });
    }
    return out;
  }
  async function threads() {
    if (threadCache && Date.now() - threadCache.at < 3000) return threadCache.list;
    const list = threadsFromDb() || await threadsFromRollouts();
    threadCache = { at: Date.now(), list };
    return list;
  }
  const names = () => config().codexNames || {};
  const titleOf = t => (names()[t.id] || t.name || t.first || 'Adsız oturum').replace(/\s+/g, ' ').slice(0, 120);
  async function listSessions(projectPath) {
    const list = (await threads()).filter(t => t.first && samePath(t.cwd, projectPath));
    return list.sort((a, b) => b.mtime - a.mtime).slice(0, 40).map(t => ({ id: t.id, title: titleOf(t), mtime: t.mtime, agent: 'codex' }));
  }
  // VoxStorm keeps its own names for Codex sessions; Codex's database is never written
  function rename(id, title, save) {
    const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!t) return { ok: false, error: 'Ad boş olamaz.' };
    if (!ID_RE.test(String(id || ''))) return { ok: false, error: 'Oturum bulunamadı.' };
    config().codexNames = { ...names(), [id]: t };
    save();
    threadCache = null;
    return { ok: true, title: t };
  }

  /* ---------- usage (tokens per response, from rollouts) ---------- */
  async function rollouts() {
    const out = [];
    const walk = async (dir, depth) => {
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) await walk(fp, depth + 1);
        else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(fp);
      }
    };
    await walk(SESSIONS(), 0);
    return out;
  }
  // token entries of one rollout; entries.limits = the plan limits Codex last reported in it
  // (token_count events carry rate_limits: primary = 5 hours, secondary = week, used_percent, resets_at)
  async function parseRollout(fp) {
    const entries = [];
    let text; try { text = await fsp.readFile(fp, 'utf8'); } catch (_) { return entries; }
    let cwd = '', model = '?';
    for (const line of text.split('\n')) {
      if (!cwd && line.includes('"session_meta"')) { try { cwd = cleanPath(JSON.parse(line).payload.cwd); } catch (_) {} continue; }
      if (line.includes('"turn_context"')) { try { const o = JSON.parse(line); if (o.type === 'turn_context' && o.payload.model) model = o.payload.model; } catch (_) {} continue; }
      if (line.includes('"rate_limits"')) {
        try {
          const o = JSON.parse(line), rl = o.payload && o.payload.rate_limits, ts = Date.parse(o.timestamp);
          if (rl && ts && (!entries.limits || ts >= entries.limits.at)) entries.limits = { at: ts, rl };
        } catch (_) {}
        continue;
      }
      if (!line.includes('"token_usage_record"')) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (o.type !== 'token_usage_record' || !o.payload || !o.payload.usage) continue;
      const u = o.payload.usage, ts = Date.parse(o.timestamp); if (!ts) continue;
      const input = Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)); // cache reads are not counted, as with Claude
      entries.push({ id: 'codex:' + (o.payload.response_id || fp + ':' + ts), ts, model, proj: encodeProjectDir(cwd || '?'), t: input + (u.output_tokens || 0), o: u.output_tokens || 0, c: null });
    }
    return entries;
  }

  // the newest limits of all rollouts as rows like Claude's plan view; a window whose reset time
  // has passed counts as unused (Codex only reports them with its next answer)
  function planRows(latest) {
    if (!latest) return null;
    const rl = latest.rl, now = Date.now(), rows = [];
    const win = (w, fallback) => {
      if (!w || w.used_percent == null) return;
      const resetMs = w.resets_at ? w.resets_at * 1000 : 0;
      const past = resetMs && resetMs <= now;
      const mins = w.window_minutes || 0;
      const title = mins === 300 ? 'Bu oturum (5 saat)' : mins === 10080 ? 'Bu hafta' : mins ? (mins % 1440 === 0 ? `${mins / 1440} günlük` : `${Math.round(mins / 60)} saatlik`) + ' pencere' : fallback;
      rows.push({ title, percent: past ? 0 : w.used_percent, resetsAt: past ? null : resetMs ? new Date(resetMs).toISOString() : null, severity: 'normal' });
    };
    win(rl.primary, 'Kısa pencere');
    win(rl.secondary, 'Uzun pencere');
    return { at: latest.at, plan: rl.plan_type || null, reached: rl.rate_limit_reached_type || null, rows };
  }

  return { launch, listSessions, rename, rollouts, parseRollout, planRows, summary, installed: () => !!launcher() };
};
