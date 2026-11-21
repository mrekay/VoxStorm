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
      return r && typeof r === 'object' ? { ok: !!r.ok, checked: !!r.checked } : { ok: !!r, checked: false };
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
      const thing = kind === 'ssh' ? 'SSH sunucusunu' : 'veritabanını';
      const r = await showBox(info, {
        title: `${info.agent} izin istiyor`, icon: kind === 'ssh' ? 'fa-server' : 'fa-database',
        message: `${info.agent}, “${item.name}” ${thing} kullanmak istiyor.`,
        detail: [
          `${kind === 'ssh' ? 'Sunucu' : 'Bağlantı'}: ${item.label}`,
          `Oturum: ${info.agent} · ${info.project}`,
          'Bağlantı bilgileri ve parolalar ajana verilmez; bağlantıyı VoxStorm kurar, ajan yalnızca çıktıyı görür.',
          'Evet dersen bu oturum, kapanana kadar bu bağlantıyı yeniden sormadan kullanabilir.',
          kind === 'ssh' ? 'İlk komut:' : 'İlk sorgu:',
        ].join('\n'),
        code: clip(what, 600),
        ok: 'Evet', cancel: 'Hayır', focusCancel: true,
        check: 'Bu kararı her zaman hatırla (bütün Claude ve Codex oturumları için)',
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
      title: `${info.agent} onay istiyor`, danger: true,
      message: `${info.agent}, “${item.name}” üzerinde veri silebilecek bir sorgu çalıştırmak istiyor.`,
      detail: `Bağlantı: ${item.label}\n\n` + notes.map(n => '• ' + n).join('\n'),
      code: clip(sql, 1500),
      ok: 'Çalıştır', cancel: 'Vazgeç',
    });
    return r.ok;
  }
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  // a yes / no in VoxStorm's dialog; ticking the box remembers yes for the rest of the session
  async function askOnce(ptyId, key, opts) {
    const set = approved.get(ptyId);
    if (set && set.has(key)) return true;
    const r = await showBox(sessionInfo(ptyId), Object.assign({ focusCancel: true, check: 'Bu oturumda bir daha sorma' }, opts));
    if (r.ok && r.checked) { if (!approved.has(ptyId)) approved.set(ptyId, new Set()); approved.get(ptyId).add(key); }
    return r.ok;
  }

  /* ---------------- tools ---------------- */
  const TOOLS = [
    {
      name: 'list_connections',
      description: 'VoxStorm’da kayıtlı SSH sunucularını ve veritabanı bağlantılarını listeler (yalnızca kimlik, ad, tür ve grup; adres ve parola verilmez). ssh_exec ve db_query bu listedeki "id" ya da "name" ile çalışır.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'ssh_exec',
      description: 'VoxStorm’da kayıtlı bir SSH sunucusunda bir kabuk komutu çalıştırır ve çıktısını (stdout, stderr, çıkış kodu) döndürür. Bağlantıyı VoxStorm kurar. Bir sunucu bu oturumda ilk kez kullanılırken kullanıcıdan VoxStorm’da onay istenir; reddedilirse aynı isteği ısrarla tekrarlama. Etkileşimli komutlar (vim, top, sudo parola sorusu) çalışmaz. Dosya yazmak için stdin kullan: ör. command "cat > /yol/dosya", stdin içerik.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'list_connections’taki id ya da ad' },
          command: { type: 'string', description: 'Sunucuda çalışacak komut' },
          stdin: { type: 'string', description: 'İsteğe bağlı: komutun standart girdisine yazılacak metin' },
          timeout_sec: { type: 'number', description: 'Zaman aşımı (varsayılan 120, en çok 900)' },
        },
        required: ['connection', 'command'], additionalProperties: false,
      },
    },
    {
      name: 'db_query',
      description: 'VoxStorm’da kayıtlı bir veritabanı bağlantısında SQL çalıştırır ve sonuçları sekmeyle ayrılmış metin olarak döndürür. Bağlantıyı VoxStorm kurar; aynı oturumda aynı bağlantı açık kalır (USE, geçici tablolar korunur). Bağlantı bu oturumda ilk kez kullanılırken kullanıcıdan onay istenir. Salt okunur bağlantılarda yazma ifadeleri engellenir; DROP, TRUNCATE ve WHERE’siz UPDATE/DELETE her seferinde kullanıcıya sorulur. Tablo ve sütunlar için INFORMATION_SCHEMA sorgulayabilirsin.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'list_connections’taki id ya da ad' },
          sql: { type: 'string', description: 'Çalışacak sorgu (MSSQL’de GO ile toplu işler ayrılabilir)' },
          database: { type: 'string', description: 'İsteğe bağlı: kullanılacak veritabanı (boşsa bağlantının varsayılanı)' },
          max_rows: { type: 'number', description: 'Sonuç kümesi başına döndürülecek en çok satır (varsayılan 200, en çok 5000)' },
          timeout_sec: { type: 'number', description: 'Zaman aşımı (varsayılan 120, en çok 900)' },
        },
        required: ['connection', 'sql'], additionalProperties: false,
      },
    },
  ];

  function find(list, ref, what) {
    const r = String(ref || '').trim();
    const lower = r.toLocaleLowerCase('tr');
    const x = list.find(c => c.id === r) || list.find(c => c.name.toLocaleLowerCase('tr') === lower);
    if (!x) throw new Error(`“${r}” adında bir ${what} bulunamadı. list_connections ile kayıtlı bağlantılara bak.`);
    return x;
  }
  // workspace tools: IDE, git, questions, terminals, Docker, plugins (agenttools.js)
  const WT = require('./agenttools')({ sessionInfo, winFor, notify, notifyTab, getDocker, getThemes, getSsh, getDb, find, authorize, askOnce, clip });
  const secs = (v, def) => Math.max(5, Math.min(900, Number(v) || def));

  async function callTool(name, a, ptyId) {
    a = a || {};
    if (WT.has(name)) {
      if (WT.needsLink(name) && !enabled()) throw new Error('VoxStorm bağlantılarının ajanlarla kullanımı Ayarlar’da kapatılmış.');
      return WT.call(name, a, ptyId);
    }
    if (!enabled()) throw new Error('VoxStorm bağlantılarının ajanlarla kullanımı Ayarlar’da kapatılmış.');
    if (name === 'list_connections') {
      const ssh = getSsh().agentList(), db = getDb().agentList();
      const note = c => (c.aiAccess === 'allow' ? 'izinli' : 'ilk kullanımda sorulur');
      return JSON.stringify({
        ssh: ssh.map(c => ({ id: c.id, name: c.name, group: c.group || undefined, access: note(c) })),
        databases: db.map(c => ({ id: c.id, name: c.name, type: c.typeName, readOnly: c.readOnly || undefined, access: note(c) })),
      }, null, 1);
    }
    if (name === 'ssh_exec') {
      const h = find(getSsh().agentList(), a.connection, 'SSH sunucusu');
      const cmd = String(a.command || '');
      if (!cmd.trim()) throw new Error('Komut boş.');
      if (!(await authorize('ssh', h, ptyId, cmd))) throw new Error(`Kullanıcı “${h.name}” sunucusunun kullanılmasına izin vermedi.`);
      const r = await getSsh().agentExec(h.id, cmd, { stdin: a.stdin, timeout: secs(a.timeout_sec, 120) * 1000 });
      const parts = [r.code === -2 ? 'Zaman aşımı: komut durduruldu.' : `Çıkış kodu: ${r.code}`];
      if (r.stdout) parts.push('--- stdout ---\n' + clip(r.stdout, MAX_TEXT) + (r.cut ? '\n… (çıktı kısaltıldı)' : ''));
      if (r.stderr) parts.push('--- stderr ---\n' + clip(r.stderr, MAX_TEXT / 4));
      if (!r.stdout && !r.stderr) parts.push('(çıktı yok)');
      return { text: parts.join('\n'), isError: r.code !== 0 };
    }
    if (name === 'db_query') {
      const c = find(getDb().agentList(), a.connection, 'veritabanı bağlantısı');
      const sql = String(a.sql || '');
      if (!sql.trim()) throw new Error('Sorgu boş.');
      if (!(await authorize('db', c, ptyId, sql))) throw new Error(`Kullanıcı “${c.name}” bağlantısının kullanılmasına izin vermedi.`);
      const info = sessionInfo(ptyId);
      const r = await getDb().agentQuery(c.id, sql, {
        session: ptyId, by: info.agent, db: a.database ? String(a.database) : '',
        maxRows: Math.max(1, Math.min(5000, Number(a.max_rows) || 200)),
        timeout: secs(a.timeout_sec, 120) * 1000,
        confirm: notes => confirmDanger(ptyId, c, notes, sql),
      });
      return { text: clip(formatQuery(r), MAX_TEXT), isError: r.failed };
    }
    throw new Error('Bilinmeyen araç: ' + name);
  }
  const cellText = v => (v === null || v === undefined ? 'NULL' : String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n'));
  function formatQuery(r) {
    const out = [];
    r.results.forEach((x, i) => {
      out.push(`# Sonuç ${i + 1}: ${x.total} satır${x.rows.length < x.total ? ` (ilk ${x.rows.length} gösteriliyor)` : ''}`);
      out.push(x.columns.map(c => c.name).join('\t'));
      for (const row of x.rows) out.push(row.map(cellText).join('\t'));
      out.push('');
    });
    for (const m of r.messages) out.push((m.type === 'error' ? 'HATA: ' : '') + m.text);
    out.push(`(${r.ms} ms${r.currentDb ? ', veritabanı: ' + r.currentDb : ''}${r.cancelled ? ', iptal edildi / zaman aşımı' : ''})`);
    return out.join('\n');
  }

  /* ---------------- MCP over HTTP ---------------- */
  const INSTRUCTIONS = 'Bu oturum VoxStorm’un içinde çalışıyor ve VoxStorm’u kullanabilirsin: dosyaları kullanıcının önünde IDE’de aç ya da işaretle (show_file, highlight_lines), kullanıcının açık dosyasını ve seçimini oku (get_editor_state), değişiklikleri git penceresinde göster ve onay iste (show_diff), soru sor (ask_user), iş bitince bildirim gönder (notify_user), görünür terminalde komut çalıştır ve terminalleri oku (run_in_terminal, read_terminal), diğer oturumlarla haberleş (send_to_session), Docker konteynerlerine bak (docker_*), eklenti araçlarını kullan (list_plugin_tools), VoxStorm’un arayüz temasını tasarla (get_theme, save_theme). Kullanıcıya bir şey göstermek ya da sormak gerektiğinde terminal metni yerine bu araçları tercih et. VoxStorm’da kayıtlı SSH sunucuları ve veritabanı bağlantıları: Önce list_connections ile hangi bağlantıların olduğuna bak. Bağlantı adresi ve parolası sana verilmez; komutu ya da sorguyu VoxStorm çalıştırır ve çıktıyı döndürür. Bir bağlantıyı ilk kullanışta kullanıcıya VoxStorm’da onay sorulur.';
  async function rpc(msg, ptyId) {
    const { id, method, params } = msg || {};
    const ok = result => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined || id === null) return null; // notification
    if (method === 'initialize') {
      return ok({
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'voxstorm', title: 'VoxStorm bağlantıları', version: version || '0' },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: enabled() ? [...WT.tools(true), ...TOOLS] : WT.tools(false) });
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
    return fail(-32601, 'Bilinmeyen yöntem: ' + method);
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
