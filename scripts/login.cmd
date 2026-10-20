@echo off
setlocal
rem reMona (AICleaner) - GitHub girisi + yayin, tek komut.
rem Kullanim:  scripts\login.cmd
rem Yaptigi:    gh ile tarayici girisi, sonra depoyu remona-code/remona adresine gonderir.
rem NOT:       Giris yapilan hesabin remona-code deposuna yazma yetkisi olmali
rem             (ya remona-code hesabinin kendisi, ya da isbirlikcisi).

cd /d "%~dp0.."

echo ============================================
echo   GitHub girisi
echo ============================================
echo.
echo Hedef depo: https://github.com/remona-code/remona
echo.
echo Birazdan bir kod ve bir adres yazilacak.
echo 1) Adresi tarayicida ac:  https://github.com/login/device
echo 2) Kodu gir ve yetkilendir
echo.
echo ONEMLI: Giris yaptigin hesabin remona-code deposuna yazma yetkisi olmali.
echo         Yetkisi yoksa giris basarili olsa bile gonderme reddedilir.
echo.
pause

gh auth login -h github.com -p https -w --skip-ssh-key
if errorlevel 1 (
  echo.
  echo GIRIS TAMAMLANMADI.
  echo Tekrar dene:  scripts\login.cmd
  exit /b 1
)

echo.
echo Giris tamam. Yayin basliyor...
echo.
call "%~dp0publish.cmd"
endlocal
