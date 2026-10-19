# Güvenlik politikası

## Desteklenen sürümler

| Sürüm | Destek |
|---|---|
| 1.x | Destekleniyor |

Depo tek bir geliştirme hattı izler (`main`). Güvenlik düzeltmeleri en son
sürüme uygulanır.

## Açık bildirimi

**Lütfen güvenlik açıkları için herkese açık issue açmayın.**

Bunun yerine deponun **Security → Report a vulnerability** bölümünden özel bir
bildirim gönderin (GitHub Security Advisories). Bildirimde şunlar olsun:

- Etkilenen sürüm ve Windows sürümü,
- Hatayı yeniden üretme adımları,
- Beklenen ve gerçekleşen davranış,
- Varsa kavram kanıtı (PoC) veya günlük çıktısı.

İlk yanıt hedefi **7 gün**, düzeltme için hedef **30 gündür**. Düzeltme
yayınlandıktan sonra, isterseniz adınızı teşekkür listesine ekleriz.

### Bildirime API anahtarı koymayın

OpenAI veya benzeri bir sağlayıcı anahtarını issue'ya, günlüğe ya da ekran
görüntüsüne **yazmayın**. Anahtar sızdıysa önce sağlayıcı panelinden iptal edin,
sonra bildirin. Uygulama anahtarı arayüze geri döndürmez; yalnızca `••••abcd`
maskesini gösterir.

## Tehdit modeli

Bu uygulama bilinçli olarak dosya siler. Bu yüzden en önemli güvenlik hedefi
**kullanıcının sistem dosyalarına ve kişisel verisine zarar vermemektir.**

Kapsam içi:

- Güvenlik kapısını atlatarak kategori beyaz listesi dışındaki bir dosyayı
  silmek veya karantinaya taşımak,
- Arayüzden gelen bir yolun doğrulanmadan motor katmanında kullanılması,
- Karantinadaki bir dosyanın geri yüklenirken hedef yolunun dışına yazması,
  üzerine yazması veya yol aşımı (path traversal) yapması,
- `contextIsolation` / `sandbox` sınırını aşan bir IPC yüzeyi: arayüzün Node
  API'sine, `require`'a veya dosya sistemine erişebilmesi,
- Kayıtlı API anahtarının düz metin olarak diske yazılması veya arayüze ya da
  üçüncü bir servise sızması,
- Zorla indirilen veya doğrulanmadan çalıştırılan bir güncelleme/bileşen.

Kapsam dışı:

- **Yönetici olarak çalıştırmanın** kendisi. Uygulama yönetici yetkisi istemez;
  `C:\Windows\Temp` gibi kategoriler yönetici olmadan kısmen okunur.
- Dosya silme işleminin geri dönüşü olmaması — **kalıcı silme** açık bir
  kullanıcı seçimidir ve onay ister. Varsayılan davranış karantinadır.
- Windows'un kendi geri dönüşüm kutusu `--empty` bayrağıyla boşaltıldığında
  bunun kullanıcı tarafından istendiği gerçeği. Bu işlem COM/PowerShell köprüsü
  üzerinden yapılır ve yalnızca açık seçimle çalışır.
- Üçüncü taraf yapay zeka sağlayıcısının (OpenAI vb.) kendi gizlilik politikası.
  Sağlayıcıya yalnızca dosya adları ve boyutları gibi **kısa bir özet** gönderilir;
  dosya içerikleri hiçbir zaman gönderilmez.

## Uygulamadaki güvenlik önlemleri

Ayrıntılı model README'nin **Güvenlik modeli** bölümündedir. Özet:

- Silinebilir kökler yalnızca `src/engine/config.js` içindeki kategori
  tanımlarıdır; her silme beyaz liste, kara liste ve kök koruması denetiminden
  geçer.
- Temizlik iki aşamalıdır: önce kuru çalıştırma raporu, sonra her dosya için
  yeniden doğrulama.
- Arayüz dosya yolu göndermez; yalnızca kategori ve öğe kimliği gönderir.
- API anahtarı işletim sisteminin şifreleme kasasıyla (Windows'ta DPAPI)
  şifrelenir ve arayüze geri döndürülmez.
- Arayüzde Node entegrasyonu kapalıdır (`contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`).
