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
      id: '2026-11-25b', title: __('Sürüm {v}', { v: '1.2.1' }), date: '2026-11-25',
      items: [
        { icon: 'fa-solid fa-window-restore', title: __('Açılan pencereler artık opak'), text: __('Temada resim olsa da ayarlar, diyaloglar, menüler ve bildirimler tam opak; arkalarından resim görünmez. İstersen tema düzenleyicideki “Açılan pencereler → Opaklık” ile buzlu cam gibi yarı saydam yaparsın.'), try: () => Themes.openEditor(null) },
      ],
    },
    {
      id: '2026-11-25', title: __('Sürüm {v}', { v: '1.2.0' }), date: '2026-11-25',
      items: [
        { icon: 'fa-solid fa-cloud-arrow-up', title: __('Deployment: FTP, FTPS ve SFTP'), text: __('IDE’de yeni Deployment paneli: projeye bir sunucu ve klasör eşlemesi ekle, dosyaları yükle / indir, karşılaştırıp senkronla, uzaktaki dosyaları doğrudan düzenle. İstersen her kayıtta ya da projedeki her değişiklikte (Claude’un düzenlemeleri dahil) otomatik yüklenir. Claude ve Codex de bu sunucuları VoxStorm üzerinden, izin alarak kullanabilir.'), try: () => setMode('ide') },
        { icon: 'fa-regular fa-images', title: __('Panellere ayrı resim'), text: __('Tema düzenleyicide resim artık yalnızca tüm pencereye değil, yan panellere, terminale ve kod editörüne ayrı ayrı konabilir; her birinin görünürlüğü ve bulanıklığı ayrı.'), try: () => Themes.openEditor(null) },
        { icon: 'fa-solid fa-terminal', title: __('Konsol renkleri temadan'), text: __('Claude ile tema tasarlarken terminal yazısı ve terminalin 16 rengi de temaya göre seçilebilir (Ayarlar → Tema → Terminal yazı renkleri: Temaya uyumlu).') },
        { icon: 'fa-solid fa-share-nodes', title: __('Tema paylaş'), text: __('Tema menüsünde temanın yanındaki paylaş düğmesi temayı resimleriyle birlikte bir .voxtheme dosyasına kaydeder; “İçe aktar” ile başkasının temasını eklersin.') },
      ],
    },
    {
      id: '2026-11-23', title: __('Sürüm {v}', { v: '1.1.0' }), date: '2026-11-23',
      items: [
        { icon: 'fa-solid fa-user-shield', title: __('sudo: kayıtlı parola ve otomatik onay'), text: __('Sunucunun düzenleme penceresine ayrı bir sudo / root parolası kaydedebilir, sudo isteklerini otomatik onaylatabilirsin. sudo penceresinde iki yeni kutu var: “Tüm oturumlar için hatırla” ve “sudo isteklerini otomatik onayla”; ikisi de sunucu ayarına yazılır.') },
        { icon: 'fa-solid fa-stopwatch', title: __('sudo’da 10 saniye'), text: __('Kayıtlı bir parola varsa sudo penceresi 10 saniye sayar; dokunmazsan kayıtlı parolayla dener. Parola yanlışsa pencere hatayla yeniden açılır.') },
      ],
    },
    {
      id: '2026-11-22', title: __('Sürüm {v}', { v: '1.0.0' }), date: '2026-11-22',
      items: [
        { icon: 'fa-solid fa-language', title: __('Beş dil'), text: __('VoxStorm artık Türkçe, İngilizce, Almanca, İspanyolca ve Fransızca. İlk açılışta sistem diline göre seçilir; Ayarlar → Dil’den değişir. Claude ve Codex’in yanıt dili ayrıca seçilir.'), try: () => openSettings('dil') },
        { icon: 'fa-solid fa-robot', title: __('Claude ve Codex VoxStorm’u kullanır'), text: __('Ajanlar dosyayı IDE’de önüne açar ve ağaçta işaretler, satırları notlarıyla işaretler, değişikliği git penceresinde gösterip “Kabul et / Geri al” diye sorar, seçenekli soru sorar, iş bitince bildirim gönderir, görünür terminalde komut çalıştırır, diğer oturumlarla haberleşir, Docker’a ve eklenti araçlarına erişir.') },
        { icon: 'fa-solid fa-palette', title: __('Kendi temanı tasarla'), text: __('Tema düzenleyicide on rengi seç, arka plana resim koy (görünürlük ve bulanıklık ayarıyla) ya da “Claude ile tasarla” de: Claude temayı tasarlayıp uygular. Yeni hazır tema: Kağıt.'), try: () => Themes.openEditor(null) },
        { icon: 'fa-solid fa-table-columns', title: __('IDE’de dock panelleri'), text: __('Dosyalar, Ara, Veritabanı ve Eklentiler artık AI modundaki gibi panel: sağa sola sürükle, alt alta böl, sekmele, raptiyeyle gizle.'), try: () => setMode('ide') },
        { icon: 'fa-solid fa-user-shield', title: __('SSH’ta sudo'), text: __('Claude bir sunucuda sudo gerektiren bir komut çalıştırınca parola VoxStorm’un kendi penceresinde, komutla birlikte sorulur; ajana hiç verilmez. İstersen oturum boyunca hatırlanır.') },
        { icon: 'fa-solid fa-link', title: __('Terminalde tıklanabilir yollar'), text: __('Terminalde geçen dosya ve klasör yollarına Ctrl+tık: klasör dosya yöneticisinde, proje dosyası IDE’de (satırıyla) açılır. Alt satıra kırılmış ve boşluklu yollar da tanınır.') },
      ],
      small: [__('Projeye sağ tık: aynı menü, “IDE sahnesinde göster” ile.'), __('Sorular ve onaylar artık hep VoxStorm’un kendi penceresinde; sistemin mesaj kutuları kullanılmıyor.')],
    },
    {
      id: '2026-11-20c', title: __('Sürüm {v}', { v: '0.9.0' }), date: '2026-11-20',
      items: [
        { icon: 'fa-solid fa-plug-circle-check', title: __('Claude ve Codex, SSH ve veritabanlarını VoxStorm üzerinden kullanır'), text: __('Ajanlar VoxStorm’da kayıtlı SSH sunucularında komut, veritabanlarında sorgu çalıştırabilir. Bağlantıyı VoxStorm kurar; adres, kullanıcı adı ve parola ajana hiç verilmez, ajan yalnızca bağlantının adını ve komutun çıktısını görür. Bir bağlantıyı ilk kullanmak istediğinde sorulur: Evet / Hayır, istersen “her zaman hatırla”. Salt okunur bağlantılar korunur; DROP, TRUNCATE ve WHERE’siz UPDATE/DELETE her seferinde ayrıca sorulur. Kararları bağlantının düzenleme penceresinden değiştirebilir, özelliği Ayarlar’dan kapatabilirsin.'), try: () => openSettings() },
        { icon: 'fa-solid fa-diagram-project', title: __('Workflow ayrıntıları'), text: __('Ajan panelinde bir workflow’a tıklayınca oturumuna geçilir ve ayrıntı penceresi açılır: fazlar, her fazdaki ajanlar, model, token, süre, ajanın o an ne yaptığı; biten ajanların sonucu ve commit’leri. Pencere açıkken canlı güncellenir.') },
        { icon: 'fa-solid fa-star', title: __('Favori projeler'), text: __('Karşılama ekranında ve Proje Başlat panelinde projeyi yıldızla; favoriler listenin başında durur. Yeni eklenen proje de artık oturumu olmadığı için en alta düşmüyor.'), try: () => showPanel('side').then(() => openStartPanel()) },
      ],
      small: [__('Bir oturumun sekmesine bakınca o oturumun bildirimleri zildeki listeden de kalkıyor.'), __('Ajan panelinde workflow’lar “Workflow” yerine kendi adıyla görünüyor.'), __('Proje altındaki git satırı dar panelde taşmıyor.')],
    },
    {
      id: '2026-11-20b', title: __('Sürüm {v}', { v: '0.8.1' }), date: '2026-11-20',
      items: [
        { icon: 'fa-solid fa-folder-plus', title: __('Yeni proje ekleme penceresi'), text: __('Klasörü sürükle-bırak, seç ya da yolunu yapıştır. Claude’un çalıştığı klasörler aranabilir listede; art arda birkaç tane ekleyebilirsin. IDE gezgininde proje seçicinin yanındaki + ile de açılır.'), try: () => openDiscover() },
        { icon: 'fa-solid fa-bars', title: __('Oturumlarda sağ tık menüsü'), text: __('Soldaki oturum listesinde sağ tık artık doğrudan yeniden adlandırmıyor; menü açılır: gruba ekle, yeniden adlandır, kapat. Dışarıdaki ve geçmiş oturumlarda izle, taşı, devam et.') },
        { icon: 'fa-solid fa-puzzle-piece', title: __('Eklentilere menü ve ipucu'), text: __('Eklentiler oturum, proje ve dosya sağ tık menülerine öğe ekleyebilir, düğmelerine açılır menü koyabilir, kendi sayfalarından menü açabilir. Eklenti sayfalarındaki title’lar uygulamanın temalı ipucuyla görünür.') },
      ],
      small: [__('Soldan bir oturuma tıklayınca, sekme çok olsa da üst şerit o sekmeye kayıyor.')],
    },
    {
      id: '2026-11-20', title: __('Sürüm {v}', { v: '0.8.0' }), date: '2026-11-20',
      items: [
        { icon: 'fa-brands fa-openai', title: __('Codex desteği'), text: __('Claude Code’un yanında OpenAI Codex oturumları: + Oturum menüsünden ya da Ctrl+Shift+X ile aç. İzin kartları, bitince bildirim, geçmiş ve kaldığın yerden devam, alt ajanlar ve arka planda süren komutlar ajan panelinde. Codex kurulu değilse hiçbir yerde görünmez.'), keys: 'Ctrl+Shift+X', try: () => { if (INFO && INFO.codex) setMode('claude'); else toast(__('Codex kurulu değil'), __('npm i -g @openai/codex, ardından codex login.')); } },
        { icon: 'fa-solid fa-wand-magic-sparkles', title: __('Varsayılan yapay zekâ'), text: __('Ayarlarda Claude ya da Codex seç: Ctrl+Shift+N ve “… sor” düğmeleri (IDE, DB) seçtiğine gider.') },
        { icon: 'fa-solid fa-chart-column', title: __('Codex kullanımı'), text: __('Haftalık kullanım panelinde Claude / Codex seçici: Codex’in token grafiği ve 5 saatlik / haftalık plan limitleri.') },
        { icon: 'fa-brands fa-linux', title: __('Linux desteği'), text: __('VoxStorm artık Linux’ta da çalışıyor: AppImage ve .deb. Güncellemeler AppImage’da uygulama içinden gelir.') },
        { icon: 'fa-solid fa-file-import', title: __('Terminale sürükle-bırak'), text: __('Gezginden ya da masaüstünden dosya/klasörü terminale bırak; yolu tırnaklı olarak yazılır.') },
        { icon: 'fa-solid fa-sliders', title: __('Tek sayfa ayarlar'), text: __('Claude, Codex ve hitap ayarları tek kaydırılabilir “Yapay zekâ” sayfasında: ortak ayarlar açık, Claude ve Codex bölümleri katlanır.') },
      ],
      small: [__('Panel başlıklarındaki sabitle ve kapat düğmeleri hep görünür; yanındaki düğmeler artık kaymıyor.'), __('Terminalde emojili satırlarda harflerin üst üste binmesi düzeldi.'), __('Görev çubuğu simgesi güncel logo.')],
    },
    {
      id: '2026-11-19', title: __('Sürüm {v}', { v: '0.7.0' }), date: '2026-11-19',
      items: [
        { icon: 'fa-solid fa-server', title: __('SSH modu'), text: __('PuTTY ve WinSCP bir arada: kayıtlı sunucular, terminal, iki panelli SFTP dosya yöneticisi (sürükle-bırak, klasör aktarımı, chmod, uzak dosyayı düzenleme), port yönlendirme tünelleri ve Uzak Masaüstü (RDP) kayıtları.'), keys: 'Ctrl+4', try: () => setMode('ssh') },
        { icon: 'fa-brands fa-docker', title: 'Docker', text: __('Git düğmesinin yanındaki Docker panelinden bu bilgisayardaki konteynerleri yönet: başlat / durdur, canlı loglar, konteynerde terminal, compose projeleri, imajlar. SSH oturumlarında da sunucudaki Docker için ayrı bir görünüm var.'), keys: 'Ctrl+Shift+Y', try: () => { const b = document.getElementById('dockerBtn'); if (b && !b.hidden) b.click(); else toast(__('Docker bulunamadı'), __('Docker Desktop kurulu olmalı.')); } },
        { icon: 'fa-solid fa-bars', title: __('IDE menü çubuğu'), text: __('Dosya, Düzen, Seçim, Görünüm, Terminal ve Yardım menüleri. Bul ve değiştir (regex), kod katlama, Ctrl+D ile çoklu imleç, satır taşıma / çoğaltma, JSON biçimlendirme, son açılan dosyalar, farklı kaydet.'), keys: 'Alt / F10', try: () => setMode('ide') },
        { icon: 'fa-solid fa-database', title: __('IDE içinde veritabanı'), text: __('Gezginde “DB” sekmesi: bağlantılar, tablolar, sütunlar. Seçili SQL’i ya da .sql dosyasında imleçteki deyimi Ctrl+Shift+Enter ile çalıştır; sonuçlar düzenleyicinin altındaki panelde.'), keys: 'Ctrl+Shift+Enter', try: () => { setMode('ide'); setExView('db'); } },
        { icon: 'fa-solid fa-up-right-from-square', title: __('Modlar ayrı pencerede'), text: __('AI, IDE, DB ya da SSH’yi kendi penceresine al (örneğin ikinci monitöre). Mod düğmesine sağ tıkla ya da Ctrl+Shift+M; pencereyi kapatınca mod ana pencereye döner.'), keys: 'Ctrl+Shift+M' },
        { icon: 'fa-solid fa-layer-group', title: __('Sekme grupları'), text: __('Bir ya da birden çok projedeki Claude oturumlarını adlı, renkli gruplara al. Sekmeye sağ tıkla ya da Ctrl+tık ile seçip Ctrl+Shift+L. Kapalı grup, içinde karar bekleyen olursa yanıp söner.'), keys: 'Ctrl+Shift+L', try: () => setMode('claude') },
        { icon: 'fa-solid fa-clock-rotate-left', title: __('Kapatılanı geri aç'), text: __('Yanlışlıkla kapattığın Claude oturumu konuşmasıyla geri gelir. Sekme çubuğunda + yanındaki düğme sonuncuyu açar, ▾ ile proje adı ve zamanıyla listeden seçersin. Zaten açık olan oturumlar listede görünmez.'), keys: 'Ctrl+Alt+T', try: () => setMode('claude') },
        { icon: 'fa-brands fa-apple', title: __('macOS desteği'), text: __('VoxStorm artık Mac’te de çalışıyor (Apple Silicon ve Intel). Kısayollar ⌘ ile, Claude Code ve terminaller aynı; güncellemeler Mac’te de uygulama içinden gelir.') },
        { icon: 'fa-solid fa-gift', title: __('Neler yeni'), text: __('Bu ekran: yeni sürümün ilk açılışında bir kez çıkar, sağ alttaki düğmeden her zaman açılır.') },
      ],
      small: [__('Oturum adları: senin verdiğin ad yoksa ilk mesaj yerine Claude’un oturuma verdiği başlık (terminal başlığındaki) kullanılıyor; açık sekmelerde de anında güncelleniyor.'), __('Mod düğmeleri hap yerine Git düğmesi gibi köşeli.')],
    },
    {
      id: '2026-11-16', title: __('Sürüm {v}', { v: '0.6.0' }), date: '2026-11-16',
      items: [
        { icon: 'fa-solid fa-table-columns', title: __('Dock düzeninde yan paneller'), text: __('Visual Studio / VS Code gibi: simge şeritleri, sekmeli ve bölünebilir gruplar, sürükle-bırak ile dock pusulası, otomatik gizleme (raptiye), katlama ve boyutlandırma.') },
        { icon: 'fa-solid fa-gauge-high', title: __('Plan limitleri'), text: __('Haftalık kullanım panelinde Claude Code /usage gibi plan limitleri modu.') },
        { icon: 'fa-brands fa-chrome', title: __('Chrome ve açılış komutu'), text: __('Claude oturumlarını --chrome ile başlatma ve varsayılan açılış komutu. Karşılama ekranında projeye tıklayınca doğrudan yeni oturum.') },
      ],
    },
    {
      id: '2026-11-14', title: __('Sürüm {v}', { v: '0.5.1 – 0.5.2' }), date: '2026-11-14',
      items: [
        { icon: 'fa-solid fa-robot', title: __('Arka plan ajanları'), text: __('Arka plan alt ajanları ve workflow’lar bitene kadar aktif listede kalıyor; tıklayınca ajanın konuşması açılıyor.') },
        { icon: 'fa-solid fa-computer-mouse', title: __('Sekme çubuğu'), text: __('Sekme çubukları düz fare tekerleğiyle yana kayıyor.') },
      ],
    },
  ];
  // NOTES dates are YYYY-MM-DD; shown in the interface language ("20 Kasım 2026")
  const fmtDate = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'long', year: 'numeric' }); };
  const newest = NOTES[0].id;
  const seen = () => String((CFG && CFG.settings && CFG.settings.whatsNewSeen) || '');
  const unseen = () => seen() < newest;

  let bg = null;
  function build() {
    bg = document.createElement('div');
    bg.className = 'settings-bg wn-bg';
    bg.hidden = true;
    bg.innerHTML = `<div class="wn" role="dialog" aria-modal="true" aria-labelledby="wnTitle">
      <div class="wn-h"><i class="fa-solid fa-gift"></i><span id="wnTitle">${__('Neler yeni')}</span><button class="ghost" data-wn="close">${__('Kapat')} <i class="fa-solid fa-xmark"></i></button></div>
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
      ${it.keys || it.try ? `<div class="wn-f">${it.keys ? `<span class="wn-k">${it.keys.split(' / ').map(k => k.split('+').map(x => `<kbd>${esc(x)}</kbd>`).join('')).join(' <span>/</span> ')}</span>` : ''}${it.try ? `<button class="btn" data-wn="try:${n}:${i}">${__('Dene')} <i class="fa-solid fa-arrow-right"></i></button>` : ''}</div>` : ''}</div></div>`;
  }
  function render() {
    const [cur, ...old] = NOTES;
    bg.querySelector('.wn-body').innerHTML = `
      <div class="wn-rel"><div class="wn-rh"><b>${esc(cur.title)}</b><span>${esc(fmtDate(cur.date))}</span></div>
        <div class="wn-grid">${cur.items.map((it, i) => card(it, 0, i)).join('')}</div>
        ${cur.small ? `<ul class="wn-small">${cur.small.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}</div>
      ${old.map((r, n) => `<div class="wn-old"><button class="wn-ot" data-wn="older"><i class="fa-solid fa-chevron-right"></i><b>${esc(r.title)}</b><span>${esc(fmtDate(r.date))}</span></button>
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
  const chipHtml = () => `<button class="sb-chip wn-chip${unseen() ? ' new' : ''}" data-whatsnew="1" title="${esc(__('Neler yeni (Ctrl+Shift+F1)'))}"><i class="fa-solid fa-gift"></i> ${__('Neler yeni')}${unseen() ? '<span class="wn-dot"></span>' : ''}</button>`;
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
  try { SHORTCUTS.push({ group: __('Genel'), keys: 'Ctrl+Shift+F1', label: __('Neler yeni'), run: () => open() }); } catch (_) {}
})();
