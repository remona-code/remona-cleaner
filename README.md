# reMona (AICleaner)

[![Lisans: MIT](https://img.shields.io/badge/lisans-MIT-3da639.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6.svg)](#kurulum-ve-çalıştırma)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-3c873a.svg)](#kurulum-ve-çalıştırma)
[![Çalışma zamanı bağımlılığı](https://img.shields.io/badge/%C3%A7al%C4%B1%C5%9Fma%20zaman%C4%B1%20ba%C4%9F%C4%B1ml%C4%B1l%C4%B1%C4%9F%C4%B1-yok-success.svg)](#mimari)

Yapay zeka destekli Windows disk temizleyici. Electron ile yazılmış gerçek bir
masaüstü uygulaması: tarayıcıda açılan bir web sayfası değil, kendi penceresi,
kendi simgesi ve kendi paketleyicisi olan bir uygulama.

> **Marka:** ürünün adı **reMona**; **AICleaner** uygulamanın ürün adı ve
> teknik kimliği olarak korunur (ortam değişkenleri `AICLEANER_*`, arayüz
> köprüsü `window.aicleaner`). Eski sürümlerin verisi ilk açılışta
> `%APPDATA%\AICleaner\data` → `%APPDATA%\reMona AICleaner\data` olarak
> kopyalanır.

![reMona (AICleaner) arayüzü — disk halkası, kategori kartları ve yapay zeka
içgörü paneli](docs/screenshot.jpg)

## Ne yapar

Diskteki gereksiz dosyaları bulur, her grup için bir **güven skoru** üretir,
güvenli olanları önerir ve temizliği **geri alınabilir** biçimde yapar.

Taranan kategoriler:

| Kategori | Risk | Ne bulur |
|---|---|---|
| Kullanıcı Geçici Dosyaları | Güvenli | `%TEMP%` altındaki artıklar |
| Windows Geçici Klasörü | Dikkatli | `C:\Windows\Temp` |
| Tarayıcı Önbellekleri | Güvenli | Chrome, Edge, Brave, Opera, Firefox önbellekleri |
| Windows Update Artıkları | Dikkatli | `SoftwareDistribution\Download` |
| Küçük Resim Önbelleği | Güvenli | `Explorer\thumbcache_*.db` |
| Prefetch Dosyaları | Dikkatli | `C:\Windows\Prefetch` |
| Çökme Dökümleri | Güvenli | WER ve CrashDumps klasörleri |
| Sistem ve Uygulama Günlükleri | Dikkatli | `.log`, `.etl`, `.dmp` dosyaları |
| Geri Dönüşüm Kutusu | Dikkatli | Kutunun tamamı |
| Eski İndirilenler | Riskli | 180 günden eski indirmeler |
| Büyük Dosyalar | Riskli | > 300 MB dosyalar (derin tarama) |
| Kopya Dosyalar | Riskli | Aynı içerikli dosyalar (derin tarama) |

## Üç katmanlı yapay zeka

1. **Kural motoru (her zaman açık).** Kategori riski, dosya yaşı, boyut ve disk
   doluluğundan 0-100 arası bir güven skoru üretir; Türkçe içgörüler yazar.
   İnternet gerektirmez, her zaman çalışır.
2. **Akıllı seçim.** "Şu kadar GB boşalt" hedefi verildiğinde en güvenli ve en
   verimli kategorileri sıralayıp hedefe ulaşmaya çalışır.
3. **Dil modeli (varsa).** Yerel Ollama ya da OpenAI uyumlu bir uç nokta
   bağlanırsa soruları doğal dille yanıtlar. Yoksa 1. katman yanıtlar —
   uygulama hiçbir zaman modele bağımlı değildir.

### OpenAI bağlama

Model uygulamanın içinden eklenir: **Ayarlar → AI sağlayıcısı**.

- **Sağlayıcı:** Otomatik / OpenAI / Yerel (Ollama) / Yalnızca kural motoru.
  *Otomatik* sırayla yerel modeli, OpenAI'yi ve kural motorunu dener.
- **API anahtarı** bir kez girilir; `settings.json` içine işletim sisteminin
  şifreleme kasasıyla (Windows'ta DPAPI) yazılır ve arayüze asla geri
  döndürülmez — yalnızca `••••abcd` biçiminde maskesi gösterilir.
- **Uç nokta** boş bırakılırsa `https://api.openai.com/v1` kullanılır. OpenAI
  uyumlu her sunucu (LM Studio, vLLM, OpenRouter…) aynı alandan bağlanır.
- **Model** listesi `/models` ucundan okunur; **Bağlantıyı test et** düğmesi
  seçilen modelle tek bir deneme isteği atıp sonucu bildirir.

Ortam değişkenleri desteklenir; ayar dosyasındaki değer önceliklidir:

```bat
set AICLEANER_OPENAI_BASE=https://api.openai.com/v1
set AICLEANER_OPENAI_MODEL=gpt-4o-mini
set OPENAI_API_KEY=sk-...
set AICLEANER_OLLAMA_URL=http://127.0.0.1:11434
set AICLEANER_OLLAMA_MODEL=llama3.2
```

## Kurulum ve çalıştırma

Gereksinim: **Node.js 20 veya üzeri** (test edilen: Node 24).

En kolay yol: **`baslat.bat`** dosyasına çift tıklayın. Eksik bağımlılıkları
kendisi kurar ve uygulamayı açar.

Komut satırından:

```bat
npm install
npm start
```

Geliştirici modu (DevTools ve ayrıntılı günlük):

```bat
npm run dev
```

## Paketleme (kurulum dosyası)

```bat
npm run dist
```

`release\reMona-1.0.0-setup.exe` üretilir. Tek dosyalık, kurulabilir bir
Windows uygulaması. Yalnızca taşınabilir bir klasör istiyorsanız:

```bat
npm run pack
```

## Doğrulama

```bat
npm test          :: motor testleri (node:test)
npm run smoke     :: gerçek diskte salt okunur tarama, hiçbir şey silmez
node scripts/smoke.js --deep   :: büyük dosya ve kopya taraması dahil
```

Arayüzü açmadan görsel doğrulama (pencereyi açar, PNG yazar, kapanır):

```bat
node_modules\electron\dist\electron.exe . --capture=.remona\ui-check.png
```

`npm run smoke` gerçek sistemi tarar ve disk, geri dönüşüm kutusu, kategori
dağılımı, AI özeti ve güvenlik köklerinin bir dökümünü yazar. Silme yapmaz.

## Güvenlik modeli

Bu uygulama dosya siler, bu yüzden güvenlik modeli kasıtlı olarak dar tutuldu.

- **Beyaz liste.** Yalnızca `src/engine/config.js` içinde tanımlı kategori
  köklerinin altındaki dosyalar silinebilir. Başka hiçbir yol kabul edilmez.
- **Kara liste.** `System32`, `SysWOW64`, `WinSxS`, `Windows\Fonts`,
  `Windows\System`, `Windows\servicing`, `config\systemprofile` gibi sistem
  bileşenleri fragman eşleşmesiyle engellenir.
- **Kök koruması.** Sürücü kökü, kullanıcı klasörü ve `Desktop`, `Documents`,
  `Pictures`, `Music`, `Videos` klasörlerinin *kendisi* silinemez (içlerindeki
  dosyalar silinebilir).
- **İki aşamalı doğrulama.** Seçim önce `preview` (kuru çalıştırma) ile
  raporlanır; gerçek temizlikte her dosya yeniden güvenlik kapısından geçer.
- **Karantina varsayılan.** Dosyalar silinmez, `%APPDATA%\reMona AICleaner\data\
  quarantine\<oturum>\` altına taşınır ve manifest ile saklanır. Tek tıkla geri
  yüklenebilir. Kalıcı silme ayrı ve açık bir seçimdir.
- **Arayüz yolu görmez.** Temizlenecek dosya listesi hiçbir zaman arayüzden
  gelmez; arayüz yalnızca kategori ve öğe kimliği gönderir, yollar ana süreçte
  bellekteki tarama sonucundan çözülür. Arayüzde Node API'si, `require` veya
  dosya sistemi erişimi yoktur (`contextIsolation: true`, `sandbox: true`).

## Mimari

```
electron/
  main.js        pencere, IPC kanalları, tarama/temizlik orkestrasyonu
  preload.js     contextBridge: sayılı yetkiler, ipcRenderer sızdırılmaz
src/engine/
  config.js      kategoriler, güvenlik sınırları  <- tek doğruluk kaynağı
  utils.js       dosya gezme, joker çözme, hash, silme güvenlik kapısı
  scanner.js     kategori tarayıcıları + disk bilgisi
  ai.js          güven skoru, içgörü, akıllı seçim, opsiyonel LLM
  cleaner.js     karantina, geri yükle, kalıcı silme, geçmiş
  trash.js       Windows Geri Dönüşüm Kutusu köprüsü (PowerShell/COM)
  store.js       ayar, geçmiş ve son tarama deposu (atomik JSON)
src/renderer/
  index.html     arayüz iskeleti ve ikon sprite'ı
  styles.css     koyu, cam yüzeyli tema ve hareket sistemi
  app.js         görünümler, seçim modeli, IPC çağrıları
scripts/smoke.js motor duman testi (salt okunur)
tests/           node:test motor testleri
```

Veri klasörü: `%APPDATA%\reMona AICleaner\data`
(`settings.json`, `history.json`, `last_scan.json`, `quarantine/`).

Bu yol `electron/main.js` içinde `app.setPath('userData', …)` ile açıkça
sabitlenir: ürün adı değiştiğinde veri yerinde kalsın ve aynı makinede kurulu
başka bir reMona uygulamasıyla (ör. IDE) klasör/tek örnek kilidi çakışmasın.

## Klavye kısayolları

| Kısayol | İşlev |
|---|---|
| `Ctrl+R` | Arayüzü yenile |
| `Ctrl+Shift+I` / `F12` | Geliştirici araçları |

## Sorun giderme

**Pencere açılmıyor.** Komut satırında `npm start` çalıştırıp hata mesajına
bakın. Electron ikilisi eksikse `node node_modules\electron\install.js` yazın.

**Tarama çok yavaş.** Derin tarama kapalıyken (varsayılan) yalnızca hızlı
kategoriler taranır. Büyük Dosyalar ve Kopya Dosyalar yalnızca derin taramada
çalışır.

**Geri dönüşüm kutusu okunamıyor.** Bu köprü PowerShell üzerinden çalışır.
Kurumsal makinelerde ilke (policy) engelliyorsa kategori boş görünür, diğer
kategoriler etkilenmez.

**Uygulama açılıyor gibi olup hemen kapanıyor.** Konsolda
`Unable to move the cache: Erişim engellendi` yazıyorsa başka bir süreç aynı
`userData` klasörünü tutuyordur. `%APPDATA%\reMona AICleaner` klasörünü
kilitleyen süreci kapatın; yol çakışmaları için `electron/main.js` başındaki
`USER_DATA_DIR` tanımına bakın.

## Katkı

Katkılara açık. Başlamadan önce [CONTRIBUTING.md](CONTRIBUTING.md) dosyasını
okuyun: geliştirme komutları, kod düzeni ve dosya silen kod için geçerli
güvenlik kuralları orada.

**Güvenlik açıklarını herkese açık issue olarak bildirmeyin.**
[SECURITY.md](SECURITY.md) dosyasındaki özel bildirim yolunu izleyin.

## Lisans

[MIT](LICENSE) — Copyright (c) 2026 reMona (AICleaner) contributors.

Yazılımı kullanabilir, değiştirebilir ve dağıtabilirsiniz; tek koşul telif
bildirimini korumanızdır. Yazılım garanti olmadan sunulur. Bu uygulama dosya
siler; önemli verinizin yedeğini alın ve ilk çalıştırmada karantina modunu
koruyun.
