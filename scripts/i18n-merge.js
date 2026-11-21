#!/usr/bin/env node
/* VoxStorm — merge translated JSON pieces into a language file (src/i18n/<lang>.js).
   node scripts/i18n-merge.js <lang> piece1.json [piece2.json …]
   A piece is { "Türkçe anahtar": "translation" | { "one": "…", "other": "…" } }. Empty values are skipped.
   The language file is rewritten in a stable format; existing translations stay unless a piece replaces them. */
const fs = require('fs');
const path = require('path');

const [lang, ...pieces] = process.argv.slice(2);
if (!lang || !pieces.length) { console.error('kullanım: node scripts/i18n-merge.js <lang> parca.json …'); process.exit(2); }
const file = path.join(__dirname, '..', 'src', 'i18n', lang + '.js');
const cur = Object.assign({}, require(file));
const head = fs.readFileSync(file, 'utf8').split('\n')[0];
let added = 0, bad = 0;
const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
for (const p of pieces) {
  let d;
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error(`${p}: JSON okunamadı: ${e.message}`); process.exit(1); }
  for (const [k, v] of Object.entries(d)) {
    if (v == null || v === '') continue;
    const vs = typeof v === 'object' ? [v.one, v.other] : [v];
    if (vs.some(x => typeof x !== 'string' || !x)) { console.error(`! biçim: ${JSON.stringify(k)}`); bad++; continue; }
    // every placeholder of the key must survive (a translation may drop none and add none)
    if (vs.some(x => ph(x) !== ph(k)) && !(typeof v === 'object' && vs.every(x => ph(x).split(',').every(q => !q || ph(k).split(',').includes(q))))) { console.error(`! yer tutucu: ${JSON.stringify(k)} -> ${JSON.stringify(v)}`); bad++; continue; }
    if (cur[k] === undefined) added++;
    cur[k] = v;
  }
}
const body = Object.entries(cur).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
fs.writeFileSync(file, `${head}\n(function (d) { if (typeof module === 'object' && module.exports) module.exports = d; else if (self.I18N) self.I18N.register('${lang}', d); })({\n${body}\n});\n`);
console.log(`${lang}: ${added} yeni, toplam ${Object.keys(cur).length}${bad ? `, ${bad} reddedildi` : ''}`);
process.exit(bad ? 1 : 0);
