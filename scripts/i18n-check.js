#!/usr/bin/env node
/* VoxStorm — interface language check (src/i18n).
   node scripts/i18n-check.js                 summary: keys, and per language missing / wrong placeholders / unused
   node scripts/i18n-check.js --missing en    the missing keys of a language as a JSON object (key: "")
   node scripts/i18n-check.js --keys          every key, one per line (JSON strings)
   node scripts/i18n-check.js --leftovers [file]   string literals with Turkish letters that are not wrapped in __()
   Keys come from __('literal') calls in src/**.js and from the static text of index.html / welcome.html. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const SKIP = [path.join(SRC, 'i18n'), path.join(SRC, 'plugin-sdk')];
const I18N = require(path.join(SRC, 'i18n', 'i18n.js'));

function files(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.some(s => p.startsWith(s))) continue;
    if (e.isDirectory()) files(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// read a JS string literal starting at i (quote char at i); returns { value, end } or null for templates with ${}
function literal(src, i) {
  const q = src[i];
  let j = i + 1, raw = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { raw += c + src[j + 1]; j += 2; continue; }
    if (q === '`' && c === '$' && src[j + 1] === '{') return null;
    if (c === q) break;
    raw += c; j++;
  }
  let value;
  try { value = Function('"use strict";return ' + q + raw + q)(); } catch (_) { return null; }
  return { value, end: j + 1 };
}

const keys = new Map(); // key -> [where]
const dynamic = [];
const add = (k, where) => { if (!keys.has(k)) keys.set(k, []); keys.get(k).push(where); };

for (const f of files(SRC, '.js')) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  const re = /(^|[^\w$.])__\(\s*/g;
  let m;
  while ((m = re.exec(src))) {
    const i = m.index + m[0].length;
    const line = src.slice(0, i).split('\n').length;
    if (!`'"\``.includes(src[i])) { dynamic.push(`${rel}:${line}`); continue; }
    const l = literal(src, i);
    if (!l) { dynamic.push(`${rel}:${line} (template with \${})`); continue; }
    add(l.value, `${rel}:${line}`);
  }
}
// static HTML: text between tags and translatable attributes
for (const f of [path.join(SRC, 'renderer', 'index.html'), path.join(SRC, 'renderer', 'welcome.html')]) {
  const html = fs.readFileSync(f, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const rel = path.relative(ROOT, f);
  const ent = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  for (const m of html.matchAll(/>([^<>]+)</g)) { const k = I18N.key(ent(m[1])); if (/\p{L}{2}/u.test(k)) add(k, rel); }
  for (const m of html.matchAll(/\s(?:title|placeholder|aria-label|data-tip|alt)="([^"]*)"/g)) { const k = I18N.key(ent(m[1])); if (/\p{L}{2}/u.test(k)) add(k, rel); }
}

const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const loc = code => require(path.join(SRC, 'i18n', code + '.js'));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };

if (process.argv.includes('--keys')) { for (const k of keys.keys()) console.log(JSON.stringify(k)); process.exit(0); }
if (process.argv.includes('--missing')) {
  const d = loc(arg('--missing'));
  const out = {};
  for (const k of keys.keys()) if (!Object.prototype.hasOwnProperty.call(d, k) || d[k] === '') out[k] = '';
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}
if (process.argv.includes('--leftovers')) {
  const only = arg('--leftovers');
  for (const f of files(SRC, '.js')) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (only && !rel.endsWith(only.replace(/\\/g, '/'))) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (!/[ğüşıöçĞÜŞİÖÇ]/.test(code)) return;
      // drop the wrapped strings, comments and locale-aware calls, then look for Turkish letters left in literals
      const rest = code.replace(/__\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '').replace(/toLocale\w*\(\s*'tr'\s*\)|localeCompare\([^)]*\)/g, '');
      if (/(['"`])(?:\\.|(?!\1)[^\\])*[ğüşıöçĞÜŞİÖÇ](?:\\.|(?!\1)[^\\])*\1/.test(rest) || /`[^`]*[ğüşıöçĞÜŞİÖÇ]/.test(rest) || />[^<>]*[ğüşıöçĞÜŞİÖÇ][^<>]*</.test(rest)) console.log(`${rel}:${i + 1}: ${l.trim().slice(0, 160)}`);
    });
  }
  process.exit(0);
}

console.log(`${keys.size} anahtar`);
if (dynamic.length) console.log(`__() ilk argümanı düz metin değil (${dynamic.length}):\n  ` + dynamic.slice(0, 30).join('\n  '));
let bad = 0;
for (const [code] of I18N.LANGS) {
  if (code === 'tr') continue;
  const d = loc(code);
  const missing = [...keys.keys()].filter(k => !Object.prototype.hasOwnProperty.call(d, k) || d[k] === '');
  const unused = Object.keys(d).filter(k => !keys.has(k));
  const wrong = [];
  for (const k of keys.keys()) {
    const v = d[k]; if (v == null || v === '') continue;
    const vs = typeof v === 'object' ? [v.one, v.other].filter(x => x != null) : [v];
    if (typeof v === 'object' && !/\{n\}/.test(k)) wrong.push(k + '  (one/other ama {n} yok)');
    for (const x of vs) if (ph(x) && ph(x) !== ph(k) && !ph(k).split(',').every(p => !p || ph(x).split(',').includes(p))) wrong.push(k);
    for (const x of vs) if (ph(x).split(',').some(p => p && !ph(k).split(',').includes(p))) wrong.push(k + '  (fazladan yer tutucu)');
  }
  bad += missing.length + wrong.length;
  console.log(`${code}: ${keys.size - missing.length}/${keys.size} çevrili · eksik ${missing.length} · hatalı yer tutucu ${wrong.length} · kullanılmayan ${unused.length}`);
  if (process.argv.includes('-v')) { for (const k of wrong) console.log('  ! ' + k); for (const k of missing.slice(0, 20)) console.log('  - ' + k); }
}
process.exit(bad && process.argv.includes('--strict') ? 1 : 0);
