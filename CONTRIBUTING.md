# Katkı rehberi

reMona (AICleaner) katkılara açık. Bu dosya, bir değişikliği hazırlarken
uymanız gereken ölçütleri anlatır. Küçük bir düzeltme için bile bir issue açmak
iyi bir başlangıçtır: böylece aynı işi iki kişi yapmaz.

## Gereksinimler

- **Node.js 18 veya üzeri** (geliştirme Node 24 ile yapıldı).
- **Windows 10/11.** Uygulama Windows'a özgüdür: geri dönüşüm kutusu köprüsü
  PowerShell/COM kullanır, yol varsayımları Windows'a göredir. Linux/macOS
  desteği için açılmış bir çalışma yok.

## Kurulum

```bat
git clone <depo-adresi>
cd <proje-klasoru>
npm install
npm start
```

`npm install` Electron ikilisini indirir (yaklaşık 235 MB). Yalnızca testleri
koşacaksanız ikiliyi indirmeniz gerekmez:

```bat
npm ci --ignore-scripts
npm test
```

## Geliştirme komutları

| Komut | İşlev |
|---|---|
| `npm start` | Uygulamayı açar |
| `npm run dev` | DevTools ve ayrıntılı günlükle açar |
| `npm test` | Motor testleri (`node:test`) |
| `npm run smoke` | Gerçek diskte salt okunur tarama; hiçbir şey silmez |
| `npm run pack` | Taşınabilir klasör üretir |
| `npm run dist` | NSIS kurulum dosyası üretir |

Arayüzü açmadan görsel doğrulama — pencereyi açar, PNG yazar, kapanır:

```bat
node_modules\electron\dist\electron.exe . --capture=.remona\ui-check.png
```

## Değişiklikten önce

1. **Testleri çalıştırın.** `npm test` temiz geçmiyorsa önce onu düzeltin.
2. **Motoru değiştirdiyseniz duman testini de koşun.** `npm run smoke` gerçek
   sistemi tarar ve sayıları raporlar; salt okunurdur.
3. **Var olan bir hatayı düzeltiyorsanız** hatayı yeniden üreten bir test
   ekleyin. Testler `tests/` altında, `node:test` ile yazılır.

## Dosya silen kodda güvenlik kuralları

Bu uygulama gerçekten dosya siler. Motor katmanına dokunan bir katkıda aşağıdaki
kurallar pazarlık konusu değildir:

- **Yeni bir silme yolu eklemeyin.** Silinebilir kökler yalnızca
  `src/engine/config.js` içindeki kategori tanımlarıdır. Kullanıcıdan veya
  arayüzden gelen bir yol asla doğrudan silinmez.
- **Güvenlik kapısını atlamayın.** Her silme `src/engine/utils.js` içindeki
  beyaz liste / kara liste / kök koruması denetiminden geçer. Bu denetimi
  "hız için" devre dışı bırakan bir değişiklik kabul edilmez.
- **Karantinayı varsayılan bırakın.** Kalıcı silme açık bir kullanıcı seçimidir.
- **Arayüze dosya sistemi erişimi vermeyin.** `contextIsolation: true` ve
  `sandbox: true` korunur; `preload.js` yalnızca sayılı yetkiler açar ve
  `ipcRenderer` nesnesini sızdırmaz.

Bir güvenlik açığı bulduysanız lütfen issue açmayın — [SECURITY.md](SECURITY.md)
dosyasındaki yolu izleyin.

## Kod düzeni

- **Dil:** kod ve yorumlar Türkçe, tanımlayıcılar İngilizce sözlükte.
- **Stil:** mevcut dosyaların düzenini izleyin — 2 boşluk girinti, tek tırnak,
  noktalı virgül. Ayrı bir biçimlendirici yapılandırması yok; çevre dosyaya uyar.
- **Yorumlar:** yalnızca kodun kendisinin anlatamadığı bir kısıtı yazın
  ("neden" gerekiyorsa). Ne yaptığını anlatan yorum eklemeyin.
- **Bağımlılık:** çalışma zamanı bağımlılığı eklemeyin. Uygulama bilinçli olarak
  sıfır çalışma zamanı bağımlılığıyla yazıldı; `electron` ve `electron-builder`
  yalnızca geliştirme bağımlılığıdır. Yeni bir bağımlılık gerekiyorsa önce
  issue'da gerekçelendirin.

## Commit ve pull request

- Commit mesajı kısa ve emir kipinde olsun: `karantina geri yükleme hatasını düzelt`.
- Bir PR tek bir konuya odaklansın; ilgisiz düzenlemeleri ayrı PR'a bölün.
- PR açıklamasında **ne** değiştiğini ve **nasıl doğruladığınızı** yazın
  (hangi komut, hangi çıktı).
- Arayüz değişikliği içeriyorsa önce/sonra ekran görüntüsü ekleyin.
- CI yeşil olmadan birleştirme yapılmaz.

## Lisans

Katkı göndererek, katkınızın deponun [MIT lisansı](LICENSE) altında
yayınlanmasına izin vermiş olursunuz.
