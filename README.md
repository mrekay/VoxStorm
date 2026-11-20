# VoxStorm

Claude Code ve Codex oturumlarını tek pencereden yöneten Windows, macOS ve Linux masaüstü uygulaması.

> Resmi bir Anthropic ürünü değildir. Bilgisayarında kurulu [Claude Code](https://claude.com/claude-code) ile çalışır.

## Özellikler

- **Sekmeli terminaller:** Claude, PowerShell, Komut İstemi ve Git Bash yan yana (macOS ve Linux'ta zsh ve bash)
- **Projeler ve geçmiş:** Eski oturuma tıkla, kaldığın yerden devam et; kapanışta açık olanları geri yükle
- **Karar paneli:** İzin istekleri, plan onayları ve Claude'un soruları tek yerde
- **Bildirimler:** İş bitince, karar beklenince, alt ajan veya workflow açılıp kapanınca
- **Sistem tepsisi:** Kapatınca tepside çalışmaya devam eder, sadece tepsiden "Çık" ile kapanır
- **IDE modu:** Dosya ağacı, renkli düzenleyici, Markdown görünümü, "Claude'a sor"
- **Kullanım:** Haftalık ve aylık token, API fiyatıyla dolar karşılığı, CSV dışa aktarma
- **Oturum ayarları:** Varsayılan model, efor, izin modu, Remote Control
- **Kişiselleştirme:** Hitap, ton ve dil; üç tema; gizlenebilir paneller; kısayollar (F1)

## Kurulum

[Releases](../../releases) sayfasından indir:

- `VoxStorm-Setup-x.y.z.exe`: normal kurulum
- `VoxStorm-Portable-x.y.z.exe`: kurulumsuz, tek dosya

Gerekenler: Windows 10/11 ve PATH'te `claude` komutu (Claude Code). Git Bash isteğe bağlı.

Dosyalar imzasız olduğu için Windows ilk açılışta uyarı verebilir: **Ek bilgi → Yine de çalıştır**.

### macOS

- `VoxStorm-x.y.z-mac-arm64.dmg`: Apple Silicon (M1 ve sonrası)
- `VoxStorm-x.y.z-mac-x64.dmg`: Intel Mac

Gerekenler: macOS 12+ ve `claude` komutu (Claude Code). VoxStorm, Finder'dan açılsa da giriş kabuğunun PATH'ini okur; Homebrew veya `~/.local/bin` altındaki `claude`, `git`, `gh` bulunur.

Uygulama Apple tarafından onaylanmadığı (notarize edilmediği) için ilk açılışta uyarı çıkar: Uygulamalar klasöründe VoxStorm'a **sağ tık → Aç → Aç**. Uyarı yine de açtırmazsa: `xattr -dr com.apple.quarantine /Applications/VoxStorm.app`

macOS'taki farklar:

- Uygulama kısayolları **⌘** ile çalışır (⌘1, ⌘⇧P, ⌘P…); **⌃ Control** terminalde kalır (⌃C durdurur, ⌃R arar). Sekmeler arasında ⌃Tab.
- Sistem tepsisi yerine menü çubuğu simgesi; Dock simgesine tıklayınca pencere geri gelir.
- Plan limitleri, Claude Code'un Anahtar Zinciri'ndeki girişiyle okunur; ilk seferde macOS izin sorabilir.
- VoxStorm dışında açık oturumların terminaline bağlanma (ayna) yalnızca Windows'ta var; macOS'ta konuşma izlenir, **VoxStorm'a taşı** ile devam edilir.
- Otomatik güncelleme Windows'taki gibi çalışır: yeni sürüm indirilir, GitHub'daki SHA-256 özetiyle doğrulanır, yeniden başlatınca (ya da çıkışta) kurulur. Bunun için VoxStorm Uygulamalar klasöründe olmalı; .dmg içinden ya da İndirilenler'den doğrudan açılan kopya kendini güncelleyemez.

### Linux

- `VoxStorm-x.y.z-linux-x86_64.AppImage`: her dağıtımda çalışır, kendini günceller. `chmod +x` ile çalıştırılabilir yap. Ubuntu 22.04 ve sonrasında AppImage için `libfuse2` (24.04'te `libfuse2t64`) gerekir.
- `VoxStorm-x.y.z-linux-amd64.deb`: Debian / Ubuntu: `sudo apt install ./VoxStorm-x.y.z-linux-amd64.deb`. Güncellemeler bildirilir, yeni .deb'i aynı şekilde kurarsın.

Gerekenler: x64 Linux, `claude` (ve/veya `codex`) komutu, `curl` (hook'lar için). VoxStorm giriş kabuğunun PATH'ini okur; `~/.local/bin`, `~/.npm-global/bin` ve `/snap/bin` de aranır.

Linux'taki farklar:

- Kısayollar Windows'taki gibi **Ctrl** ile; terminaller bash ve zsh.
- Kaydedilen parolalar sistemin anahtarlığında (GNOME Keyring / KWallet) şifrelenir; anahtarlık yoksa parola kaydedilmez, her bağlantıda sorulur.
- Uzak Masaüstü FreeRDP (`xfreerdp3` / `xfreerdp`) ya da Remmina ile açılır. Eklenti paketleri için `zip` / `unzip` gerekir.
- Docker yerelde Docker Engine ya da Docker Desktop ile çalışır; kullanıcının `docker` grubunda olması gerekir.
- Dışarıda açık oturumların terminaline bağlanma (ayna) yok; macOS'taki gibi konuşma izlenir.

## Geliştirme

```
npm install
npm start        # uygulamayı çalıştır
npm run dist     # Windows: Setup ve Portable dosyalarını dist/ klasörüne derle
npm run dist:mac # macOS: .dmg ve .zip (arm64 + x64) dosyalarını dist/ klasörüne derle
npm run dist:linux # Linux: .AppImage ve .deb (x64) dosyalarını dist/ klasörüne derle (Linux'ta çalıştır)
```

## Nasıl çalışır

- Claude oturumları, VoxStorm'un kendi hook ayarlarıyla (`--settings`) başlatılır. Hook'lar olayları uygulamanın yerel portuna gönderir; durumlar, bildirimler ve karar paneli buradan beslenir. `~/.claude/settings.json` ve `CLAUDE.md` dosyalarına dokunulmaz.
- Geçmiş oturumlar ve kullanım, `~/.claude/projects` altındaki oturum kayıtlarından okunur.
- Ayarlar, proje listesi ve günlük kullanım geçmişi `%APPDATA%\VoxStorm` (macOS'ta `~/Library/Application Support/VoxStorm`, Linux'ta `~/.config/VoxStorm`) klasöründe tutulur.

## Proje yapısı

| Dosya | Görevi |
|---|---|
| `src/main/main.js` | Pencere, tepsi, terminal süreçleri, hook dinleyicisi, geçmiş ve kullanım |
| `src/main/preload.js` | Arayüze açılan sınırlı API |
| `src/main/platform.js` | Windows / macOS / Linux farkları: PATH, kabuklar, komut bulma |
| `src/renderer/` | Ana pencere (`index.html`, `app.js`, `styles.css`) ve karşılama ekranı (`welcome.*`) |
| `scripts/make-icon.js` | Uygulama simgesini üretir |
