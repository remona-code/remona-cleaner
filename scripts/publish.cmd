@echo off
setlocal enabledelayedexpansion
rem reMona (AICleaner) - GitHub yayin betigi.
rem Kullanim:  scripts\publish.cmd
rem Onkosul:    gh auth login -h github.com

cd /d "%~dp0.."

set REPO=remona
set DESC=reMona (AICleaner) - yapay zeka destekli Windows disk temizleyici

gh auth status >nul 2>&1
if errorlevel 1 (
  echo.
  echo OTURUM YOK: once su komutu calistir ^(tarayicida tek kullanimlik kod^):
  echo    gh auth login -h github.com
  echo.
  exit /b 1
)

git diff --quiet 2>nul
git diff --cached --quiet 2>nul
for /f %%s in ('git status --porcelain') do (
  echo.
  echo UYARI: commit edilmemis degisiklik var. Once commit et, sonra tekrar calistir:
  echo    git add -A ^&^& git commit -m "aciklama"
  echo.
  exit /b 1
)

git remote 2>nul | findstr /x /c:"origin" >nul
if errorlevel 1 (
  echo [1/4] Depo olusturuluyor: %REPO%
  gh repo create %REPO% --public --source=. --remote=origin --push --description "%DESC%"
) else (
  echo [1/4] Uzak adres zaten bagli, gonderiliyor
  git push -u origin main
)
if errorlevel 1 (
  echo HATA: depo olusturulamadi veya gonderilemedi.
  exit /b 1
)

for /f "delims=" %%o in ('gh api user --jq .login') do set OWNER=%%o
set SLUG=%OWNER%/%REPO%
echo [2/4] Depo: https://github.com/!SLUG!

node scripts\set-repo-url.js "!SLUG!"
if errorlevel 1 exit /b 1

git add package.json
git commit -q -m "depo baglantilarini ve konu etiketlerini ekle"
git push -q
if errorlevel 1 exit /b 1

echo [3/4] Konu etiketleri ekleniyor
gh repo edit "!SLUG!" --add-topic electron --add-topic windows --add-topic disk-cleaner --add-topic openai --add-topic ai --add-topic open-source >nul 2>&1

echo [4/4] Bitti
echo    https://github.com/!SLUG!
endlocal
