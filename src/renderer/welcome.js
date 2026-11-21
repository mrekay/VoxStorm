'use strict';
/* global api */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lower = s => String(s || '').toLocaleLowerCase('tr');
const fmtUsd = n => '$' + n.toLocaleString(I18N.locale(), { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });
const fmtTok = n => n >= 1e6 ? __('{n} M', { n: (n / 1e6).toLocaleString(I18N.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : n >= 1e3 ? __('{n} B', { n: Math.round(n / 1e3) }) : String(n);
function rel(ms) {
  if (!ms) return '';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return __('az önce');
  if (m < 60) return __('{n} dk önce', { n: m });
  const h = Math.floor(m / 60); if (h < 24) return __('{n} saat önce', { n: h });
  const g = Math.floor(h / 24); if (g === 1) return __('dün');
  if (g < 7) return __('{n} gün önce', { n: g });
  return new Date(ms).toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'long' });
}

/* ---------- greetings ----------
   {, h}  → ", Başkanım"      { h} → " Başkanım"      {h, } → "Başkanım, "
   all three disappear when no form of address is set */
const GREET = {
  morning: [
    __('Günaydın{, h}! Bugün ne yapıyoruz?'),
    __('Kahveler hazır mı{ h}? Nereden başlıyoruz?'),
    __('Güne hangi projeyle başlıyoruz{, h}?'),
    __('Erkencisin{, h}. Hangi projeyi açıyoruz?'),
  ],
  day: [
    __('Hoş geldin{, h}. Bugün ne yapıyoruz?'),
    __('{h, }hangi projeye dalıyoruz?'),
    __('Emrin olur{, h}. Nereden başlayalım?'),
    __('Hazırım{, h}. Hangi projeyi açıyoruz?'),
  ],
  evening: [
    __('İyi akşamlar{, h}. Ne üzerinde çalışıyoruz?'),
    __('Akşam mesaisi mi{ h}? Hangi proje?'),
    __('Günün son işi ne olsun{, h}?'),
  ],
  night: [
    __('Gece kuşu musun{ h}? Bugün ne yapıyoruz?'),
    __('Bu saatte kod yazılır{, h}. Hangi proje?'),
    __('Herkes uyuyor, biz çalışıyoruz{, h}. Nereden başlıyoruz?'),
  ],
  any: [
    __('Bugün ne yapıyoruz{, h}?'),
    __('Sıradaki iş ne{, h}?'),
    __('{h, }bugün neyi bitiriyoruz?'),
    __('Bir proje seç{, h}, gerisini birlikte hallederiz.'),
  ],
  monday: [__('Yeni hafta, yeni iş{, h}. Nereden başlıyoruz?')],
  friday: [__('Cuma geldi{, h}. Haftayı neyle kapatıyoruz?')],
  weekend: [__('Hafta sonu mesaisi mi{ h}? Hangi proje?')],
};
function greetingPool(now) {
  const h = now.getHours(), d = now.getDay();
  const slot = h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'day' : h >= 17 && h < 22 ? 'evening' : 'night';
  const pool = [...GREET[slot], ...GREET.any];
  if (d === 1) pool.push(...GREET.monday);
  if (d === 5) pool.push(...GREET.friday);
  if (d === 0 || d === 6) pool.push(...GREET.weekend);
  return pool;
}
function fillGreeting(tpl, name) {
  const n = esc(name.trim());
  const em = `<em>${n}</em>`;
  let s = tpl
    .replace('{, h}', n ? ', ' + em : '')
    .replace('{ h}', n ? ' ' + em : '')
    .replace('{h, }', n ? em + ', ' : '');
  // capitalise the first letter when the sentence no longer starts with the name
  s = s.replace(/^([a-zçğıöşü])/, c => c.toLocaleUpperCase('tr'));
  return s;
}

/* ---------- state ---------- */
let DATA = { projects: [], name: '' };
let view = [], sel = 0, pool = [], greetIdx = 0;
const HUES = ['#8b5cf6', '#0ea5a4', '#e0883a', '#d9508a', '#3b82f6', '#16a34a', '#c2410c', '#6366f1'];
const hueOf = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
const initials = s => { const w = s.replace(/[-_.]+/g, ' ').trim().split(/\s+|(?=[A-Z])/).filter(Boolean); return ((w[0] || '?')[0] + ((w[1] || '')[0] || (w[0] || '')[1] || '')).toLocaleUpperCase('tr'); };

function mark(text, q) {
  if (!q) return esc(text);
  const i = lower(text).indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}
function render() {
  const q = lower($('#wlQ').value.trim());
  view = DATA.projects.filter(p => !q || lower(p.name).includes(q) || lower(p.path).includes(q));
  sel = Math.min(sel, Math.max(0, view.length - 1));
  $('#wlCount').textContent = q ? `${view.length} / ${DATA.projects.length}` : '';
  if (!DATA.projects.length) {
    $('#wlList').innerHTML = `<div class="wl-empty">${__('Henüz proje yok.<br>Soldan <b>Klasör aç…</b> ile bir proje ekle.')}</div>`;
    return;
  }
  if (!view.length) { $('#wlList').innerHTML = `<div class="wl-empty">${__('“{q}” ile eşleşen proje yok.', { q: esc($('#wlQ').value) })}</div>`; return; }
  const favs = view.filter(p => p.fav).length;
  const head = i => (!favs ? '' : i === 0 ? `<div class="wl-sec"><i class="fa-solid fa-star"></i> ${__('Favoriler')}</div>` : i === favs && favs < view.length ? `<div class="wl-sec">${__('Diğer projeler')}</div>` : '');
  $('#wlList').innerHTML = view.map((p, i) => `${head(i)}
    <div class="wl-row ${i === sel ? 'sel' : ''}" role="option" aria-selected="${i === sel}" data-i="${i}">
      <div class="wl-av" style="background:${hueOf(p.name)}">${esc(initials(p.name))}</div>
      <div class="wl-info">
        <div class="wl-name">${mark(p.name, q)}<button class="wl-star ${p.fav ? 'on' : ''}" data-fav="${i}" title="${esc(p.fav ? __('Favorilerden çıkar') : __('Favorilere ekle: listenin başında durur'))}" aria-label="${esc(p.fav ? __('Favorilerden çıkar') : __('Favorilere ekle'))}"><i class="fa-${p.fav ? 'solid' : 'regular'} fa-star"></i></button></div>
        <div class="wl-path">${mark(p.path, q)}</div>
        ${p.missing ? `<div class="wl-miss">${__('Klasör bulunamadı')}</div>` : p.lastTitle ? `<div class="wl-last" title="${esc(p.lastTitle)}">${__('Son: {title}', { title: esc(p.lastTitle) })}</div>` : ''}
      </div>
      <div class="wl-right">
        <div class="wl-meta">${p.last ? rel(p.last) : p.added ? __('yeni eklendi') : __('oturum yok')}${p.count ? `<br>${__('{n} oturum', { n: p.count })}` : ''}</div>
        <div class="wl-btns"><button class="btn primary" data-act="claude" data-i="${i}" title="Ctrl+Enter">${__('+ Oturum')}</button>${p.restore
          ? `<button class="btn" data-act="restore" data-i="${i}" title="${esc(__('Son kapanışta bu projede açık olan {n} terminali yeniden açar', { n: p.restore }))}">${__('Geri yükle ({n})', { n: p.restore })}</button>`
          : p.last ? `<button class="btn" data-act="restore" data-i="${i}" title="${esc(p.lastTitle)}">${__('Son oturuma devam')}</button>` : ''}<button class="btn" data-act="ide" data-i="${i}">${__('IDE\'de aç')}</button></div>
      </div>
    </div>`).join('');
  const el = $('.wl-row.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
}
function open(i, action) {
  const p = view[i]; if (!p) return;
  api.send('welcome:open', { projectId: p.id, action });
}
function setGreeting(next) {
  if (next) greetIdx = (greetIdx + 1) % pool.length;
  $('#wlGreet').innerHTML = fillGreeting(pool[greetIdx], DATA.name || '');
}

async function load() {
  DATA = await api.invoke('welcome:data');
  const own = String(DATA.skin || '').startsWith('custom:') && (DATA.customThemes || []).find(t => 'custom:' + t.id === DATA.skin);
  if (own && window.Themes) Themes.show(own); // themes.js
  else if (DATA.skin && DATA.skin !== 'violet' && !String(DATA.skin).startsWith('custom:')) document.documentElement.dataset.skin = DATA.skin;
  const now = new Date();
  $('#wlDate').textContent = now.toLocaleDateString(I18N.locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  pool = greetingPool(now);
  greetIdx = Math.floor(Math.random() * pool.length);
  setGreeting(false);
  const last = DATA.projects.find(p => p.last);
  $('#wlSub').innerHTML = last
    ? __('En son <b>{name}</b> üzerinde çalıştın · {when}', { name: esc(last.name), when: rel(last.last) })
    : __('Bir proje seç ya da yeni bir klasör aç.');
  const stats = [__('<b>{n}</b> proje', { n: DATA.projects.length })];
  if (DATA.usage != null) stats.push(__('bu hafta <b>{tokens}</b> token', { tokens: fmtTok(DATA.usage) }) + (DATA.cost != null ? ` (≈ <b>${fmtUsd(DATA.cost)}</b>)` : ''));
  if (DATA.open) stats.push(__('<b>{n}</b> açık terminal', { n: DATA.open }));
  $('#wlStats').innerHTML = stats.join(' · ');
  $('#restoreAll').disabled = !DATA.restoreAll;
  $('#restoreN').textContent = DATA.restoreAll || '';
  $('#restoreAll').title = DATA.restoreAll ? __('Son kapanışta açık olan {n} terminali yeniden açar', { n: DATA.restoreAll }) : __('Geri yüklenecek oturum yok');
  render();
  $('#wlQ').focus();
  if (DATA.usage == null) {
    // usage scan may still be running at startup; fill it in when it finishes
    api.invoke('usage:get').then(u => { if (u && u.total != null) { stats.splice(1, 0, __('bu hafta <b>{tokens}</b> token', { tokens: fmtTok(u.total) }) +(u.cost != null ? ` (≈ <b>${fmtUsd(u.cost)}</b>)` : '')); $('#wlStats').innerHTML = stats.join(' · '); } }).catch(() => {});
  }
}

$('#wlQ').addEventListener('input', () => { sel = 0; render(); });
$('#wlQ').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(view.length - 1, sel + 1); render(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
  else if (e.key === 'Enter') { e.preventDefault(); open(sel, modKey(e) ? 'claude' : 'select'); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if ($('#wlQ').value) { $('#wlQ').value = ''; render(); } else api.send('welcome:close'); }
});
$('#wlList').addEventListener('click', async e => {
  const f = e.target.closest('[data-fav]');
  if (f) { const p = view[+f.dataset.fav]; if (p) { await api.invoke('project:fav', p.id, !p.fav); await load(); } return; }
  const b = e.target.closest('[data-act]');
  if (b) { open(+b.dataset.i, b.dataset.act); return; }
  const row = e.target.closest('.wl-row');
  if (row) open(+row.dataset.i, 'select');
});
$('#wlList').addEventListener('mousemove', e => {
  const row = e.target.closest('.wl-row');
  if (row && +row.dataset.i !== sel) { sel = +row.dataset.i; $$rows().forEach(r => r.classList.toggle('sel', +r.dataset.i === sel)); }
});
const $$rows = () => [...document.querySelectorAll('.wl-row')];
$('#wlGreet').addEventListener('click', () => setGreeting(true));
$('#wlGreet').title = __('Başka bir selam için tıkla');
$('#addFolder').onclick = async () => {
  const p = await api.invoke('welcome:addFolder');
  if (p) await load();
};
$('#openMain').onclick = () => api.send('welcome:open', null);
$('#openSettings').onclick = () => api.send('welcome:open', { action: 'settings' });
$('#restoreAll').onclick = () => api.send('welcome:open', { action: 'restoreAll' });
$('#wlClose').onclick = () => api.send('welcome:close');
$('#wlMin').onclick = () => api.send('welcome:min');
document.addEventListener('dragstart', e => e.preventDefault());
load();
