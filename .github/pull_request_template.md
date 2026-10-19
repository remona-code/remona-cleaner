## Ne değişti

<!-- Kısa özet. Tek bir konuya odaklanın. -->

## Neden

<!-- Hangi sorunu çözüyor? İlgili issue: "Kapatır #12" -->

## Nasıl doğrulandı

<!-- Hangi komut, hangi çıktı. "Testler geçti" tek başına yeterli değil. -->

```bat
npm test
npm run smoke
```

## Kontrol listesi

- [ ] `npm test` temiz geçiyor
- [ ] Motor katmanına dokunduysa `npm run smoke` çalıştırıldı (salt okunur)
- [ ] Yeni silme kökü eklenmedi; silinebilir yollar yalnızca `src/engine/config.js` içinde
- [ ] `contextIsolation` / `sandbox` korundu, `preload.js` yeni bir dosya sistemi yetkisi açmadı
- [ ] Arayüz değiştiyse önce/sonra ekran görüntüsü eklendi
- [ ] Commit mesajı kısa ve emir kipinde
- [ ] Katkımı MIT lisansı altında yayınlamaya izin veriyorum
