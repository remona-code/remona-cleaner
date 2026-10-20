@echo off
setlocal enabledelayedexpansion
rem reMona (AICleaner) - GitHub yayin betigi.
rem Kullanim:  scripts\publish.cmd            (varsayilan hedef: remona-code/remona)
rem            scripts\publish.cmd kullanici/depo
rem Onkosul:    gh auth login -h github.com   (remona-code hesabina erisimi olan hesapla)

cd /d "%~dp0.."

set OWNER=remona-code
set REPO=remona
if not "%~1"=="" (
  set SLUG=%~1
  for /f "tokens=1,2 delims=/" %%a in ("%~1") do (
    set OWNER=%%a
    set REPO=%%b
  )
) else (
  set SLUG=%OWNER%/%REPO%
)

set DESC=reMona (AICleaner) - yapay zeka destekli Windows disk temizleyici
set URL=https://github.com/%SLUG%

echo ============================================
echo   Hedef depo: %SLUG%
echo ============================================
echo.

rem gh auth status, kayitli baska bir hesabin belirteci gecersizse 1 dondurebilir;
rem bu yuzden aktif hesabi dogrudan soruyoruz.
set GH_LOGIN=
for /f "usebackq delims=" %%u in (`gh api user --jq .login 2^>nul`) do set GH_LOGIN=%%u
if "%GH_LOGIN%"=="" (
  echo OTURUM YOK veya GECERSIZ.
  echo Once giris yap ^(remona-code hesabina erisimi olan hesapla^):
  echo    scripts\login.cmd
  echo veya
  echo    gh auth login -h github.com
  exit /b 1
)
echo   Aktif GitHub hesabi: %GH_LOGIN%
if /i not "%GH_LOGIN%"=="%OWNER%" echo   NOT: "%OWNER%" bir kullanici hesabiysa gonderim reddedilebilir.
echo.

for /f %%s in ('git status --porcelain') do (
  echo.
  echo UYARI: commit edilmemis degisiklik var. Once commit et, sonra tekrar calistir:
  echo    git add -A ^&^& git commit -m "aciklama"
  exit /b 1
)

echo [1/4] Uzak depo kontrol ediliyor
gh repo view "%SLUG%" >nul 2>&1
if errorlevel 1 (
  echo       Depo yok, olusturuluyor: %SLUG%
  gh repo create "%SLUG%" --public --description "%DESC%" >nul
  if errorlevel 1 (
    echo HATA: depo olusturulamadi. "%OWNER%" hesabina yazma yetkiniz var mi?
    exit /b 1
  )
) else (
  echo       Depo zaten var.
)

git remote 2>nul | findstr /x /c:"origin" >nul
if errorlevel 1 (
  git remote add origin "%URL%.git"
  if errorlevel 1 exit /b 1
) else (
  git remote set-url origin "%URL%.git"
)

echo [2/4] Gonderiliyor: main -> %SLUG%
git push -u origin main
if errorlevel 1 (
  echo HATA: gonderilemedi. Kimlik dogrulamayi kontrol edin: gh auth status
  exit /b 1
)

echo [3/4] package.json depo baglantilari dolduruluyor
node scripts\set-repo-url.js "%SLUG%"
if errorlevel 1 exit /b 1

git add package.json
git diff --cached --quiet
if errorlevel 1 (
  git commit -q -m "depo baglantilari: %SLUG%"
  if errorlevel 1 exit /b 1
  git push -q
  if errorlevel 1 exit /b 1
) else (
  echo       package.json zaten guncel.
)

echo [4/4] Konu etiketleri ekleniyor
gh repo edit "%SLUG%" --add-topic electron --add-topic windows --add-topic disk-cleaner --add-topic openai --add-topic ai --add-topic open-source >nul 2>&1

echo.
echo BITTI: %URL%
endlocal
