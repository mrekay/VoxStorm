# Arayüz dilleri

VoxStorm'un arayüzü Türkçe yazılır; diğer diller bu klasördeki dosyalardan gelir.

- `i18n.js`: çekirdek. Hem main süreçte (`require`) hem pencerelerde (`<script>`) çalışır.
- `en.js`, `de.js`, `es.js`, `fr.js`: çeviriler. Anahtar kodda yazan **Türkçe metnin kendisi**, değer o dildeki karşılığı.
- `node scripts/i18n-check.js`: kaç anahtar var, hangi dilde ne eksik, yer tutucusu hatalı olan var mı.

## Kodda metin yazmak

Kullanıcının göreceği her metin `__()` ile sarılır. İlk argüman **düz bir metin** olmalı (tırnaklı ya da `${}` içermeyen ters tırnaklı), çünkü denetim betiği anahtarları kaynaktan böyle toplar.

```js
__('Kaydet')
__('“{name}” sunucusu silinsin mi?', { name: h.name })     // değişkenler {süslü} yer tutucu olur
__('{n} terminal hâlâ açık.', { n })                       // sayıya göre çoğul: çeviride { one, other }
`<h4>${__('Konuşma tonu')}</h4>`                            // HTML'in içindeki metin sarılır, etiketler dışarıda kalır
title="${esc(__('Yeni oturum'))}"                           // öznitelikte de
```

Kurallar:

- **Ne sarılır:** düğme, menü, başlık, ipucu (`title`), `placeholder`, `aria-label`, toast, diyalog, bildirim, hata mesajı; ajana (Claude / Codex) dönen araç açıklamaları ve sonuçları; oturumlara eklenen sistem metni.
- **Ne sarılmaz:** kod içi kimlikler (`data-pact="ide"`, ayar anahtarları, CSS sınıfları), log satırları, yorumlar, komut satırı argümanları, dosya yolları, `localeCompare(…, 'tr')` / `toLocaleLowerCase('tr')` gibi Türkçe sıralama ve arama çağrıları (dokunma), marka adları (VoxStorm, Claude, Codex, Docker…).
- **Cümleyi bölme.** `'Dosya ' + ad + ' silindi'` yerine `__('Dosya {name} silindi', { name })`. Çevirmen kelime sırasını değiştirebilmeli.
- **Yer tutucuya ham değer koyma, kaçışını kendin yap.** HTML içinde `__('<b>{name}</b> sunucusu', { name: esc(n) })`. Yer tutucuya giren değer çevrilmez.
- **Çoğul:** sayı `{n}` adıyla geçilir. Türkçede tekil/çoğul aynı olduğundan anahtar tek; İngilizce dosyada `{ one: '…', other: '…' }` olur.
- **Main süreçte modül yüklenirken `__()` çağırma** (dil ondan sonra seçiliyor olabilir). Sabit tablolar için fonksiyon kullan ya da çağrıyı kullanıldığı yere taşı. Pencerelerde (renderer) üst seviyede çağırmak serbest; dil ilk script'ten önce seçilir.
- **Tarih ve sayı:** `'tr-TR'` yerine `I18N.locale()` (pencerede `I18N` global, main'de `require('../i18n/i18n.js')`).
- **Aynı anlam, aynı metin.** "Vazgeç", "Kapat", "Kaydet" gibi metinleri her yerde aynı yaz; tek anahtar olur.

## Çeviri dosyası

```js
(function (d) { … })({
  'Kaydet': 'Save',
  '{n} terminal hâlâ açık.': { one: '{n} terminal is still open.', other: '{n} terminals are still open.' },
});
```

- Yer tutucular (`{name}`, `{n}`) aynen kalır; sırası değişebilir.
- HTML etiketleri ve `&nbsp;` gibi varlıklar korunur.
- Kısayol yazıları (`Ctrl+Shift+N`), kod, komut ve dosya adları çevrilmez.
- Ton: kısa, sade, uygulama dili. Türkçedeki samimi hitap ("Başkanım" vb.) o dilin doğal karşılığına uyarlanır.

Yeni dil: `en.js`'i kopyala, değerleri çevir, `i18n.js`'teki `LANGS` listesine bir satır ekle, `index.html` ve `welcome.html`'e `<script>` satırını ekle.
