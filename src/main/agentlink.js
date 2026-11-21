// VoxStorm — lets Claude Code and Codex sessions use the SSH hosts and database connections saved in
// VoxStorm, through VoxStorm. A small MCP server (streamable HTTP, JSON answers) listens on 127.0.0.1;
// every session VoxStorm starts gets its address (Claude: --mcp-config file, Codex: -c mcp_servers.…).
// The agent only ever sees connection ids and names: host names, users, ports, passwords and keys stay
// in this process. VoxStorm opens the connection, runs the command / query and sends back the output.
// The first time a session wants a connection, the user is asked (Evet / Hayır, "her zaman hatırla");
// a remembered answer is kept on the connection (aiAccess: 'allow' | 'deny', '' = ask).
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const I18N = require('../i18n/i18n.js'); const __ = I18N.t;

const MAX_TEXT = 100 * 1024; // characters of tool output sent back
const toml = s => JSON.stringify(String(s));

module.exports = function setupAgentLink({ DATA, getSsh, getDb, getDocker, getThemes, enabled, sessionInfo, notify, notifyTab, winFor, onAccessChanged, version }) {
  const token = crypto.randomBytes(18).toString('hex');
  const DIR = path.join(DATA, 'mcp');
  let port = 0;
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {} // files of the last run
  const approved = new Map(); // pty id -> Set of 'ssh:<id>' / 'db:<id>' allowed for that session
  const pending = new Map(); // one question at a time per session and connection

  /* ---------------- launch arguments ---------------- */
  const url = ptyId => `http://127.0.0.1:${port}/mcp/${token}/${encodeURIComponent(ptyId)}`;
  // the server is always attached (show_file); the SSH / DB tools only when the setting allows them
  function claudeArgs(ptyId) {
    if (!port) return [];
    fs.mkdirSync(DIR, { recursive: true });
    const f = path.join(DIR, ptyId + '.json');
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { voxstorm: { type: 'http', url: url(ptyId) } } }, null, 1));
    return ['--mcp-config', f];
  }
  function codexArgs(ptyId) {
    if (!port) return [];
    // a question waits for the user: give the tool call time
    return ['-c', `mcp_servers.voxstorm.url=${toml(url(ptyId))}`, '-c', 'mcp_servers.voxstorm.tool_timeout_sec=900'];
  }
  function release(ptyId) {
    approved.delete(ptyId);
    try { fs.unlinkSync(path.join(DIR, ptyId + '.json')); } catch (_) {}
    try { getDb().agentRelease(ptyId); } catch (_) {}
  }

  /* ---------------- asking the user ---------------- */
  // always VoxStorm's own themed dialog (ui.js uiAsk), never a system message box;
  // resolves to { ok, checked }. No window to ask in = no.
  async function showBox(info, opts) {
    const w = info.win && !info.win.isDestroyed() ? info.win : null;
    if (!w) return { ok: false, checked: false };
    if (!w.isVisible()) w.show();
    if (w.isMinimized()) w.restore();
    w.flashFrame(true);
    if (!w.isFocused()) notify(opts.title || 'VoxStorm', opts.message);
    try {
      const wc = w.webContents;
      if (wc.isLoading()) await new Promise(r => wc.once('did-finish-load', r));
      const r = await wc.executeJavaScript(`window.uiAsk(${JSON.stringify(opts)})`, true);
      return r && typeof r === 'object' ? { ok: !!r.ok, checked: !!r.checked, text: typeof r.text === 'string' ? r.text : '' } : { ok: !!r, checked: false, text: '' };
    } catch (_) {
      return { ok: false, checked: false };
    } finally {
      if (!w.isDestroyed()) w.flashFrame(false);
    }
  }
  // true when the session may use the connection
  function authorize(kind, item, ptyId, what) {
    if (item.aiAccess === 'allow') return Promise.resolve(true);
    if (item.aiAccess === 'deny') return Promise.resolve(false);
    const key = kind + ':' + item.id;
    const set = approved.get(ptyId);
    if (set && set.has(key)) return Promise.resolve(true);
    const pk = ptyId + '|' + key;
    if (pending.has(pk)) return pending.get(pk);
    const p = (async () => {
      const info = sessionInfo(ptyId);
      const r = await showBox(info, {
        title: __('{agent} izin istiyor', { agent: info.agent }), icon: kind === 'ssh' ? 'fa-server' : 'fa-database',
        message: kind === 'ssh'
          ? __('{agent}, “{name}” SSH sunucusunu kullanmak istiyor.', { agent: info.agent, name: item.name })
          : __('{agent}, “{name}” veritabanını kullanmak istiyor.', { agent: info.agent, name: item.name }),
        detail: [
          kind === 'ssh' ? __('Sunucu: {label}', { label: item.label }) : __('Bağlantı: {label}', { label: item.label }),
          __('Oturum: {agent} · {project}', { agent: info.agent, project: info.project }),
          __('Bağlantı bilgileri ve parolalar ajana verilmez; bağlantıyı VoxStorm kurar, ajan yalnızca çıktıyı görür.'),
          __('Evet dersen bu oturum, kapanana kadar bu bağlantıyı yeniden sormadan kullanabilir.'),
          kind === 'ssh' ? __('İlk komut:') : __('İlk sorgu:'),
        ].join('\n'),
        code: clip(what, 600),
        ok: __('Evet'), cancel: __('Hayır'), focusCancel: true,
        check: __('Bu kararı her zaman hatırla (bütün Claude ve Codex oturumları için)'),
      });
      const yes = r.ok;
      if (r.checked) {
        (kind === 'ssh' ? getSsh() : getDb()).setAiAccess(item.id, yes ? 'allow' : 'deny');
        onAccessChanged(kind);
      } else if (yes) {
        if (!approved.has(ptyId)) approved.set(ptyId, new Set());
        approved.get(ptyId).add(key);
      }
      return yes;
    })().finally(() => pending.delete(pk));
    pending.set(pk, p);
    return p;
  }
  // a query that can delete data is asked about every time, even on an allowed connection
  async function confirmDanger(ptyId, item, notes, sql) {
    const info = sessionInfo(ptyId);
    const r = await showBox(info, {
      title: __('{agent} onay istiyor', { agent: info.agent }), danger: true,
      message: __('{agent}, “{name}” üzerinde veri silebilecek bir sorgu çalıştırmak istiyor.', { agent: info.agent, name: item.name }),
      detail: __('Bağlantı: {label}', { label: item.label }) + '\n\n' + notes.map(n => '• ' + n).join('\n'),
      code: clip(sql, 1500),
      ok: __('Çalıştır'), cancel: __('Vazgeç'),
    });
    return r.ok;
  }
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  /* sudo on SSH hosts: there is no terminal to type a password into, so VoxStorm asks the user (its own
     dialog, the command shown), and hands the password to `sudo -S` on stdin. The agent never sees it.
     Passwordless sudo is tried first (`sudo -n`), so hosts with NOPASSWD rules don't ask at all. */
  const sudoPw = new Map(); // pty id | host id -> password remembered for that session
  const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const NEEDS_PW = /a password is required|a terminal is required|no tty present|askpass/i;
  const BAD_PW = /incorrect password|sorry, try again|authentication failure|\d+ incorrect password attempt/i;
  async function sudoPassword(ptyId, h, cmd) {
    const k = ptyId + '|' + h.id;
    if (sudoPw.has(k)) return sudoPw.get(k);
    const info = sessionInfo(ptyId);
    const saved = getSsh().agentLoginPassword ? getSsh().agentLoginPassword(h.id) : null;
    const r = await showBox(info, {
      title: __('{agent} sudo yetkisi istiyor', { agent: info.agent }), icon: 'fa-user-shield',
      message: __('{agent}, “{name}” sunucusunda bir komutu sudo ile (yönetici olarak) çalıştırmak istiyor.', { agent: info.agent, name: h.name }),
      detail: [
        __('Oturum: {agent} · {project}', { agent: info.agent, project: info.project }),
        __('Parola ajana verilmez; VoxStorm komuta doğrudan iletir.'),
        saved ? __('Boş bırakırsan bu sunucunun kayıtlı giriş parolası kullanılır.') : '',
      ].filter(Boolean).join('\n'),
      code: clip(cmd, 800), input: '', password: true, maxLength: 512,
      placeholder: saved ? __('sudo parolası (boş: kayıtlı parola)') : __('sudo parolası'),
      ok: __('Çalıştır'), cancel: __('Vazgeç'),
      check: __('Bu oturum boyunca hatırla (sudo için yeniden sorma)'),
    });
    if (!r.ok) return null;
    const pw = r.text || saved || '';
    if (r.checked) sudoPw.set(k, pw);
    return pw;
  }
  // run a command; with sudo (asked for, or a command that starts with "sudo ") as root
  async function sshRun(ptyId, h, cmd, a) {
    const SSH = getSsh(), timeout = secs(a.timeout_sec, 120) * 1000;
    let body = cmd, sudo = !!a.sudo;
    const m = /^\s*sudo\s+(?:-[a-zA-Z]+\s+)*/.exec(cmd);
    if (m && !/^\s*sudo\s+-[a-zA-Z]*[ul]/.test(cmd)) { sudo = true; body = cmd.slice(m[0].length); } // "sudo -u x …" stays as written
    if (!sudo) {
      const r = await SSH.agentExec(h.id, cmd, { stdin: a.stdin, timeout });
      if (r.code !== 0 && /\bsudo\b/.test(cmd) && NEEDS_PW.test(r.stderr)) r.stderr += '\n' + __('[VoxStorm] Bu komut sudo parolası istiyor. Komutu sudo: true ile (ya da “sudo …” ile başlayarak) yeniden gönder; VoxStorm parolayı kullanıcıdan ister.');
      return r;
    }
    const wrapped = `-- sh -c ${shq(body)}`;
    const r1 = await SSH.agentExec(h.id, `sudo -n ${wrapped}`, { stdin: a.stdin, timeout });
    if (!(r1.code !== 0 && NEEDS_PW.test(r1.stderr))) return r1; // passwordless sudo (or a real result)
    const pw = await sudoPassword(ptyId, h, body);
    if (pw == null) throw new Error(__('Kullanıcı sudo ile çalıştırmaya izin vermedi.'));
    const r2 = await SSH.agentExec(h.id, `sudo -S -p '' ${wrapped}`, { stdin: pw + '\n' + (a.stdin || ''), timeout });
    if (r2.code !== 0 && BAD_PW.test(r2.stderr)) {
      sudoPw.delete(ptyId + '|' + h.id);
      r2.stderr = __('[VoxStorm] sudo parolası yanlış; komut çalışmadı. Tekrar denersen kullanıcıya yeniden sorulur.');
    }
    return r2;
  }

  // a yes / no in VoxStorm's dialog; ticking the box remembers yes for the rest of the session
  async function askOnce(ptyId, key, opts) {
    const set = approved.get(ptyId);
    if (set && set.has(key)) return true;
    const r = await showBox(sessionInfo(ptyId), Object.assign({ focusCancel: true, check: __('Bu oturumda bir daha sorma') }, opts));
    if (r.ok && r.checked) { if (!approved.has(ptyId)) approved.set(ptyId, new Set()); approved.get(ptyId).add(key); }
    return r.ok;
  }

  /* ---------------- tools ---------------- */
  // built on each call: the descriptions follow the interface language
  const TOOLS = () => [
    {
      name: 'list_connections',
      description: __('VoxStorm’da kayıtlı SSH sunucularını ve veritabanı bağlantılarını listeler (yalnızca kimlik, ad, tür ve grup; adres ve parola verilmez). ssh_exec ve db_query bu listedeki "id" ya da "name" ile çalışır.'),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'ssh_exec',
      description: __('VoxStorm’da kayıtlı bir SSH sunucusunda bir kabuk komutu çalıştırır ve çıktısını (stdout, stderr, çıkış kodu) döndürür. Bağlantıyı VoxStorm kurar. Bir sunucu bu oturumda ilk kez kullanılırken kullanıcıdan VoxStorm’da onay istenir; reddedilirse aynı isteği ısrarla tekrarlama. Etkileşimli komutlar (vim, top) çalışmaz. Yönetici yetkisi gerekiyorsa sudo: true ver (ya da komutu “sudo …” ile başlat): VoxStorm önce parolasız sudo dener, parola gerekirse kullanıcıya kendi penceresinde sorar ve komuta iletir; parolayı asla isteme ya da komuta yazma. Dosya yazmak için stdin kullan: ör. command "cat > /yol/dosya", stdin içerik.'),
      inputSchema: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: __('list_connections’taki id ya da ad') },
          command: { type: 'string', description: __('Sunucuda çalışacak komut') },
          stdin: { type: 'string', description: __('İsteğe bağlı: komutun standart girdisine yazılacak metin') },
          timeout_sec: { type: 'number', description: __('Zaman aşımı (varsayılan 120, en çok 900)') },
          sudo: { type: 'boolean', description: __('true: komutu sudo ile (root olarak) çalıştır; parola gerekirse VoxStorm kullanıcıya sorar') },
        },
        required: ['connection', 'command'], additionalProperties: false,
      },
    },
    {
      name: 'db_query',
      description: __('VoxStorm’da kayıtlı bir veritabanı bağlantısında SQL çalıştırır ve sonuçları sekmeyle ayrılmış metin olarak döndürür. Bağlantıyı VoxStorm kurar; aynı oturumda aynı bağlantı açık kalır (USE, geçici tablolar korunur). Bağlantı bu oturumda ilk kez kullanılırken kullanıcıdan onay istenir. Salt okunur bağlantılarda yazma ifadeleri engellenir; DROP, TRUNCATE ve WHERE’siz UPDATE/DELETE her seferinde kullanıcıya sorulur. Tablo ve sütunlar için INFORMATION_SCHEMA sorgulayabilirsin.'),
      inputSchema: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: __('list_connections’taki id ya da ad') },
          sql: { type: 'string', description: __('Çalışacak sorgu (MSSQL’de GO ile toplu işler ayrılabilir)') },
          database: { type: 'string', description: __('İsteğe bağlı: kullanılacak veritabanı (boşsa bağlantının varsayılanı)') },
          max_rows: { type: 'number', description: __('Sonuç kümesi başına döndürülecek en çok satır (varsayılan 200, en çok 5000)') },
          timeout_sec: { type: 'number', description: __('Zaman aşımı (varsayılan 120, en çok 900)') },
        },
        required: ['connection', 'sql'], additionalProperties: false,
      },
    },
  ];

  // kind: 'ssh' | 'db'
  function find(list, ref, kind) {
    const r = String(ref || '').trim();
    const lower = r.toLocaleLowerCase('tr');
    const x = list.find(c => c.id === r) || list.find(c => c.name.toLocaleLowerCase('tr') === lower);
    if (!x) {
      throw new Error(kind === 'ssh'
        ? __('“{name}” adında bir SSH sunucusu bulunamadı. list_connections ile kayıtlı bağlantılara bak.', { name: r })
        : __('“{name}” adında bir veritabanı bağlantısı bulunamadı. list_connections ile kayıtlı bağlantılara bak.', { name: r }));
    }
    return x;
  }
  // workspace tools: IDE, git, questions, terminals, Docker, plugins (agenttools.js)
  const WT = require('./agenttools')({ sessionInfo, winFor, notify, notifyTab, getDocker, getThemes, getSsh, getDb, find, authorize, askOnce, clip });
  const secs = (v, def) => Math.max(5, Math.min(900, Number(v) || def));

  async function callTool(name, a, ptyId) {
    a = a || {};
    if (WT.has(name)) {
      if (WT.needsLink(name) && !enabled()) throw new Error(__('VoxStorm bağlantılarının ajanlarla kullanımı Ayarlar’da kapatılmış.'));
      return WT.call(name, a, ptyId);
    }
    if (!enabled()) throw new Error(__('VoxStorm bağlantılarının ajanlarla kullanımı Ayarlar’da kapatılmış.'));
    if (name === 'list_connections') {
      const ssh = getSsh().agentList(), db = getDb().agentList();
      const note = c => (c.aiAccess === 'allow' ? __('izinli') : __('ilk kullanımda sorulur'));
      return JSON.stringify({
        ssh: ssh.map(c => ({ id: c.id, name: c.name, group: c.group || undefined, access: note(c) })),
        databases: db.map(c => ({ id: c.id, name: c.name, type: c.typeName, readOnly: c.readOnly || undefined, access: note(c) })),
      }, null, 1);
    }
    if (name === 'ssh_exec') {
      const h = find(getSsh().agentList(), a.connection, 'ssh');
      const cmd = String(a.command || '');
      if (!cmd.trim()) throw new Error(__('Komut boş.'));
      if (!(await authorize('ssh', h, ptyId, cmd))) throw new Error(__('Kullanıcı “{name}” sunucusunun kullanılmasına izin vermedi.', { name: h.name }));
      const r = await sshRun(ptyId, h, cmd, a);
      const parts = [r.code === -2 ? __('Zaman aşımı: komut durduruldu.') : __('Çıkış kodu: {code}', { code: r.code })];
      if (r.stdout) parts.push('--- stdout ---\n' + clip(r.stdout, MAX_TEXT) + (r.cut ? '\n' + __('… (çıktı kısaltıldı)') : ''));
      if (r.stderr) parts.push('--- stderr ---\n' + clip(r.stderr, MAX_TEXT / 4));
      if (!r.stdout && !r.stderr) parts.push(__('(çıktı yok)'));
      return { text: parts.join('\n'), isError: r.code !== 0 };
    }
    if (name === 'db_query') {
      const c = find(getDb().agentList(), a.connection, 'db');
      const sql = String(a.sql || '');
      if (!sql.trim()) throw new Error(__('Sorgu boş.'));
      if (!(await authorize('db', c, ptyId, sql))) throw new Error(__('Kullanıcı “{name}” bağlantısının kullanılmasına izin vermedi.', { name: c.name }));
      const info = sessionInfo(ptyId);
      const r = await getDb().agentQuery(c.id, sql, {
        session: ptyId, by: info.agent, db: a.database ? String(a.database) : '',
        maxRows: Math.max(1, Math.min(5000, Number(a.max_rows) || 200)),
        timeout: secs(a.timeout_sec, 120) * 1000,
        confirm: notes => confirmDanger(ptyId, c, notes, sql),
      });
      return { text: clip(formatQuery(r), MAX_TEXT), isError: r.failed };
    }
    throw new Error(__('Bilinmeyen araç: {name}', { name }));
  }
  const cellText = v => (v === null || v === undefined ? 'NULL' : String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n'));
  function formatQuery(r) {
    const out = [];
    r.results.forEach((x, i) => {
      out.push(x.rows.length < x.total
        ? __('# Sonuç {i}: {n} satır (ilk {shown} gösteriliyor)', { i: i + 1, n: x.total, shown: x.rows.length })
        : __('# Sonuç {i}: {n} satır', { i: i + 1, n: x.total }));
      out.push(x.columns.map(c => c.name).join('\t'));
      for (const row of x.rows) out.push(row.map(cellText).join('\t'));
      out.push('');
    });
    for (const m of r.messages) out.push(m.type === 'error' ? __('HATA: {text}', { text: m.text }) : m.text);
    out.push(`(${r.ms} ms${r.currentDb ? __(', veritabanı: {db}', { db: r.currentDb }) : ''}${r.cancelled ? __(', iptal edildi / zaman aşımı') : ''})`);
    return out.join('\n');
  }

  /* ---------------- MCP over HTTP ---------------- */
  const INSTRUCTIONS = () => __('Bu oturum VoxStorm’un içinde çalışıyor ve VoxStorm’u kullanabilirsin: dosyaları kullanıcının önünde IDE’de aç ya da işaretle (show_file, highlight_lines), kullanıcının açık dosyasını ve seçimini oku (get_editor_state), değişiklikleri git penceresinde göster ve onay iste (show_diff), soru sor (ask_user), iş bitince bildirim gönder (notify_user), görünür terminalde komut çalıştır ve terminalleri oku (run_in_terminal, read_terminal), diğer oturumlarla haberleş (send_to_session), Docker konteynerlerine bak (docker_*), eklenti araçlarını kullan (list_plugin_tools), VoxStorm’un arayüz temasını tasarla (get_theme, save_theme). Kullanıcıya bir şey göstermek ya da sormak gerektiğinde terminal metni yerine bu araçları tercih et. VoxStorm’da kayıtlı SSH sunucuları ve veritabanı bağlantıları: Önce list_connections ile hangi bağlantıların olduğuna bak. Bağlantı adresi ve parolası sana verilmez; komutu ya da sorguyu VoxStorm çalıştırır ve çıktıyı döndürür. Bir bağlantıyı ilk kullanışta kullanıcıya VoxStorm’da onay sorulur.');
  async function rpc(msg, ptyId) {
    const { id, method, params } = msg || {};
    const ok = result => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined || id === null) return null; // notification
    if (method === 'initialize') {
      return ok({
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'voxstorm', title: __('VoxStorm bağlantıları'), version: version || '0' },
        instructions: INSTRUCTIONS(),
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: enabled() ? [...WT.tools(true), ...TOOLS()] : WT.tools(false) });
    if (method === 'resources/list') return ok({ resources: [] });
    if (method === 'prompts/list') return ok({ prompts: [] });
    if (method === 'tools/call') {
      try {
        const r = await callTool(params && params.name, params && params.arguments, ptyId);
        const text = typeof r === 'string' ? r : r.text;
        return ok({ content: [{ type: 'text', text }], isError: !!(r && r.isError) });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true });
      }
    }
    return fail(-32601, __('Bilinmeyen yöntem: {method}', { method }));
  }

  function start() {
    return new Promise(resolve => {
      const server = http.createServer((req, res) => {
        const m = /^\/mcp\/([0-9a-f]+)\/([^/?]+)/.exec(req.url || '');
        if (!m || m[1] !== token) { res.writeHead(404); res.end(); return; }
        const ptyId = decodeURIComponent(m[2]);
        if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
        const chunks = []; let size = 0;
        req.on('data', c => { chunks.push(c); size += c.length; if (size > 5e6) req.destroy(); });
        req.on('end', async () => {
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
            return;
          }
          const batch = Array.isArray(body);
          const answers = (await Promise.all((batch ? body : [body]).map(x => rpc(x, ptyId)))).filter(Boolean);
          if (!answers.length) { res.writeHead(202); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(batch ? answers : answers[0]));
        });
      });
      server.requestTimeout = 0; server.timeout = 0; // a question can wait for the user
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
      server.on('error', () => resolve(0));
    });
  }

  return { start, claudeArgs, codexArgs, release };
};
