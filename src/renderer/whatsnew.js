/* VoxStorm "Neler yeni": what changed, newest first. Shown once at start-up when there is an entry
   the user has not seen yet (settings.whatsNewSeen holds the newest seen id), and any time from
   the button at the bottom right of the status bar.
   To announce something: add an entry at the top of NOTES with a new, larger id.
   Uses globals from app.js: $, esc, CFG, setCfg, setMode, toast, SHORTCUTS. */
(() => {
  'use strict';
  // try: what the "Dene" button does (optional)
  const NOTES = [
    {
      id: '2026-11-19', title: 'SSH, Docker ve IDE yenilikleri', date: '19 Kasım 2026',
      items: [
        { icon: 'fa-solid fa-server', title: 'SSH modu', text: 'PuTTY ve WinSCP bir arada: kayıtlı sunucular, terminal, iki panelli SFTP dosya yöneticisi (sürükle-bırak, klasör aktarımı, chmod, uzak dosyayı düzenleme), port yönlendirme tünelleri ve Uzak Masaüstü (RDP) kayıtları.', keys: 'Ctrl+4', try: () => setMode('ssh') },
        { icon: 'fa-brands fa-docker', title: 'Docker', text: 'Git düğmesinin yanındaki Docker panelinden bu bilgisayardaki konteynerleri yönet: başlat / durdur, canlı loglar, konteynerde terminal, compose projeleri, imajlar. SSH oturumlarında da sunucudaki Docker için ayrı bir görünüm var.', keys: 'Ctrl+Shift+Y', try: () => { const b = document.getElementById('dockerBtn'); if (b && !b.hidden) b.click(); else toast('Docker bulunamadı', 'Docker Desktop kurulu olmalı.'); } },
        { icon: 'fa-solid fa-bars', title: 'IDE menü çubuğu', text: 'Dosya, Düzen, Seçim, Görünüm, Terminal ve Yardım menüleri. Bul ve değiştir (regex), kod katlama, Ctrl+D ile çoklu imleç, satır taşıma / çoğaltma, JSON biçimlendirme, son açılan dosyalar, farklı kaydet.', keys: 'Alt / F10', try: () => setMode('ide') },
        { icon: 'fa-solid fa-database', title: 'IDE içinde veritabanı', text: 'Gezginde “DB” sekmesi: bağlantılar, tablolar, sütunlar. Seçili SQL’i ya da .sql dosyasında imleçteki deyimi Ctrl+Shift+Enter ile çalıştır; sonuçlar düzenleyicinin altındaki panelde.', keys: 'Ctrl+Shift+Enter', try: () => { setMode('ide'); const b = document.querySelector('[data-exview=db]'); if (b) b.click(); } },
        { icon: 'fa-solid fa-up-right-from-square', title: 'Modlar ayrı pencerede', text: 'AI, IDE, DB ya da SSH’yi kendi penceresine al (örneğin ikinci monitöre). Mod düğmesine sağ tıkla ya da Ctrl+Shift+M; pencereyi kapatınca mod ana pencereye döner.', keys: 'Ctrl+Shift+M' },
        { icon: 'fa-solid fa-layer-group', title: 'Sekme grupları', text: 'Bir ya da birden çok projedeki Claude oturumlarını adlı, renkli gruplara al. Sekmeye sağ tıkla ya da Ctrl+tık ile seçip Ctrl+Shift+L. Kapalı grup, içinde karar bekleyen olursa yanıp söner.', keys: 'Ctrl+Shift+L', try: () => setMode('claude') },
        { icon: 'fa-solid fa-clock-rotate-left', title: 'Kapatılanı geri aç', text: 'Yanlışlıkla kapattığın Claude oturumu konuşmasıyla geri gelir. Sekme çubuğunda + yanındaki düğme sonuncuyu açar, ▾ ile proje adı ve zamanıyla listeden seçersin. Zaten açık olan oturumlar listede görünmez.', keys: 'Ctrl+Alt+T', try: () => setMode('claude') },
        { icon: 'fa-solid fa-gift', title: 'Neler yeni', text: 'Bu ekran: yeni sürümün ilk açılışında bir kez çıkar, sağ alttaki düğmeden her zaman açılır.' },
      ],
      small: ['Oturum adları: senin verdiğin ad yoksa ilk mesaj yerine Claude’un oturuma verdiği başlık (terminal başlığındaki) kullanılıyor; açık sekmelerde de anında güncelleniyor.', 'Mod düğmeleri hap yerine Git düğmesi gibi köşeli.'],
    },
    {
      id: '2026-11-16', title: 'Sürüm 0.6.0', date: '16 Kasım 2026',
      items: [
        { icon: 'fa-solid fa-table-columns', title: 'Dock düzeninde yan paneller', text: 'Visual Studio / VS Code gibi: simge şeritleri, sekmeli ve bölünebilir gruplar, sürükle-bırak ile dock pusulası, otomatik gizleme (raptiye), katlama ve boyutlandırma.' },
        { icon: 'fa-solid fa-gauge-high', title: 'Plan limitleri', text: 'Haftalık kullanım panelinde Claude Code /usage gibi plan limitleri modu.' },
        { icon: 'fa-brands fa-chrome', title: 'Chrome ve açılış komutu', text: 'Claude oturumlarını --chrome ile başlatma ve varsayılan açılış komutu. Karşılama ekranında projeye tıklayınca doğrudan yeni oturum.' },
      ],
    },
    {
      id: '2026-11-14', title: 'Sürüm 0.5.1 – 0.5.2', date: '14 Kasım 2026',
      items: [
        { icon: 'fa-solid fa-robot', title: 'Arka plan ajanları', text: 'Arka plan alt ajanları ve workflow’lar bitene kadar aktif listede kalıyor; tıklayınca ajanın konuşması açılıyor.' },
        { icon: 'fa-solid fa-computer-mouse', title: 'Sekme çubuğu', text: 'Sekme çubukları düz fare tekerleğiyle yana kayıyor.' },
      ],
    },
  ];
  const newest = NOTES[0].id;
  const seen = () => String((CFG && CFG.settings && CFG.settings.whatsNewSeen) || '');
  const unseen = () => seen() < newest;

  let bg = null;
  function build() {
    bg = document.createElement('div');
    bg.className = 'settings-bg wn-bg';
    bg.hidden = true;
    bg.innerHTML = `<div class="wn" role="dialog" aria-modal="true" aria-labelledby="wnTitle">
      <div class="wn-h"><i class="fa-solid fa-gift"></i><span id="wnTitle">Neler yeni</span><button class="ghost" data-wn="close">Kapat <i class="fa-solid fa-xmark"></i></button></div>
      <div class="wn-body"></div></div>`;
    document.getElementById('win').appendChild(bg);
    bg.addEventListener('click', e => {
      if (e.target === bg) { close(); return; }
      const b = e.target.closest('[data-wn]'); if (!b) return;
      const k = b.dataset.wn;
      if (k === 'close') close();
      else if (k === 'older') { b.parentElement.classList.toggle('open'); }
      else if (k.startsWith('try:')) { const [, n, i] = k.split(':'); const it = NOTES[+n].items[+i]; close(); if (it && it.try) setTimeout(it.try, 50); }
    });
    bg.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  }
  function card(it, n, i) {
    return `<div class="wn-card"><i class="${it.icon} wn-ic"></i><div class="wn-tx"><b>${esc(it.title)}</b><p>${esc(it.text)}</p>
      ${it.keys || it.try ? `<div class="wn-f">${it.keys ? `<span class="wn-k">${it.keys.split(' / ').map(k => k.split('+').map(x => `<kbd>${esc(x)}</kbd>`).join('')).join(' <span>/</span> ')}</span>` : ''}${it.try ? `<button class="btn" data-wn="try:${n}:${i}">Dene <i class="fa-solid fa-arrow-right"></i></button>` : ''}</div>` : ''}</div></div>`;
  }
  function render() {
    const [cur, ...old] = NOTES;
    bg.querySelector('.wn-body').innerHTML = `
      <div class="wn-rel"><div class="wn-rh"><b>${esc(cur.title)}</b><span>${esc(cur.date)}</span></div>
        <div class="wn-grid">${cur.items.map((it, i) => card(it, 0, i)).join('')}</div>
        ${cur.small ? `<ul class="wn-small">${cur.small.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}</div>
      ${old.map((r, n) => `<div class="wn-old"><button class="wn-ot" data-wn="older"><i class="fa-solid fa-chevron-right"></i><b>${esc(r.title)}</b><span>${esc(r.date)}</span></button>
        <div class="wn-grid">${r.items.map((it, i) => card(it, n + 1, i)).join('')}</div></div>`).join('')}`;
  }
  function open() {
    if (!bg) build();
    render();
    bg.hidden = false;
    requestAnimationFrame(() => { const c = bg.querySelector('[data-wn=close]'); if (c) c.focus(); });
    if (unseen()) { setCfg({ settings: { whatsNewSeen: newest } }); refreshChip(); }
  }
  function close() { if (bg) bg.hidden = true; }
  // the status-bar button (app.js puts chipHtml() into the status bar on every render)
  const chipHtml = () => `<button class="sb-chip wn-chip${unseen() ? ' new' : ''}" data-whatsnew="1" title="Neler yeni (Ctrl+Shift+F1)"><i class="fa-solid fa-gift"></i> Neler yeni${unseen() ? '<span class="wn-dot"></span>' : ''}</button>`;
  function refreshChip() { const c = document.querySelector('#statusbar [data-whatsnew]'); if (c) c.outerHTML = chipHtml(); }
  document.addEventListener('click', e => { if (e.target.closest('[data-whatsnew]')) open(); });

  window.whatsNew = {
    open, chipHtml,
    // at start-up: once per new entry, only in the main window
    maybeShow() {
      const only = new URLSearchParams(location.search).get('only');
      if (!only && unseen()) setTimeout(open, 600);
    },
  };
  try { SHORTCUTS.push({ group: 'Genel', keys: 'Ctrl+Shift+F1', label: 'Neler yeni', run: () => open() }); } catch (_) {}
})();
