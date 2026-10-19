@echo off
rem ===========================================================================
rem  reMona (AICleaner) - masaustu uygulama baslatici
rem  Cift tiklayin; gerekirse bagimliliklari kendisi kurar.
rem ===========================================================================
setlocal
cd /d "%~dp0"

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

if exist "%ELECTRON_EXE%" goto calistir

echo.
echo  Ilk calistirma - bagimliliklar kuruluyor.
echo  Bu islem birkac dakika surebilir, lutfen bekleyin...
echo.

where node >nul 2>nul
if errorlevel 1 goto nodemissing

call npm install --no-audit --no-fund
if errorlevel 1 goto installfail

if not exist "%ELECTRON_EXE%" (
  echo.
  echo  Electron ikilisi indiriliyor...
  call node "node_modules\electron\install.js"
  if errorlevel 1 goto installfail
)

:calistir
start "" "%ELECTRON_EXE%" .
exit /b 0

:nodemissing
echo.
echo  HATA: Node.js bulunamadi.
echo  https://nodejs.org adresinden LTS surumu kurun, sonra tekrar deneyin.
echo.
pause
exit /b 1

:installfail
echo.
echo  HATA: Bagimliliklar kurulamadi.
echo  Internet baglantinizi kontrol edip bu dosyayi tekrar calistirin.
echo.
pause
exit /b 1
