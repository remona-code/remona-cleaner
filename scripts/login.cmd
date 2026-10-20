@echo off
setlocal
rem reMona (AICleaner) - GitHub girisi + yayin, tek komut.
rem Kullanim:  scripts\login.cmd
rem Yaptigi:    gh ile tarayici girisi, sonra depoyu olusturup gonderir.

cd /d "%~dp0.."

echo ============================================
echo   GitHub girisi
echo ============================================
echo.
echo Birazdan bir kod ve bir adres yazilacak.
echo 1) Adresi tarayicida ac:  https://github.com/login/device
echo 2) Kodu gir ve yetkilendir
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
