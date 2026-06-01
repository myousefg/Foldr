@echo off
setlocal EnableDelayedExpansion

:: ============================================================
::  Foldr - Windows Build Script
::  Produces: dist\Foldr-Setup-<VERSION>.exe + checksum.txt
::
::  HOW TO CHANGE THE VERSION
::  1. Update APP_VERSION below
::  2. Update "version" in package.json to match
::  3. Update filevers/prodvers in backend\version_info.txt to match
:: ============================================================

set APP_VERSION=1.1.0
set INSTALLER_NAME=Foldr-Setup-%APP_VERSION%.exe

pushd "%~dp0.."
set PROJECT_DIR=%CD%
popd
set DIST_DIR=%PROJECT_DIR%\dist
set INSTALLER_PATH=%DIST_DIR%\%INSTALLER_NAME%
set CHECKSUM_PATH=%DIST_DIR%\checksum.txt
set PS_TEMP=%TEMP%\foldr_checksum_%RANDOM%.ps1

echo.
echo =============================================
echo   Foldr Build  v%APP_VERSION%
echo =============================================
echo.

:: ── Step 1: Python backend ──────────────────────────────────
echo [1/4] Building Python backend with PyInstaller...
cd /d "%PROJECT_DIR%\backend"
pip install pyinstaller --quiet
pyinstaller foldr_backend.spec --clean --noconfirm
if errorlevel 1 ( echo ERROR: PyInstaller failed. Aborting. & pause & exit /b 1 )
echo       Done. Output: backend\dist\foldr-backend.exe
echo.

:: ── Step 2: React frontend ──────────────────────────────────
echo [2/4] Building React frontend...
cd /d "%PROJECT_DIR%\frontend"
call yarn install --frozen-lockfile
call yarn build
if errorlevel 1 ( echo ERROR: React build failed. Aborting. & pause & exit /b 1 )
echo       Done. Output: frontend\build\
echo.

:: ── Step 3: Electron-builder ────────────────────────────────
echo [3/4] Packaging installer with electron-builder...
cd /d "%PROJECT_DIR%"
call npm install --silent
call npm run dist
if errorlevel 1 ( echo ERROR: electron-builder failed. Aborting. & pause & exit /b 1 )
echo       Done. Output: dist\%INSTALLER_NAME%
echo.

:: ── Step 4: SHA-256 checksum ────────────────────────────────
echo [4/4] Generating SHA-256 checksum...
if not exist "%INSTALLER_PATH%" (
    echo WARNING: Installer not found - skipping checksum.
    goto :done
)

:: Write ps1 to temp file - avoids all CMD quoting/parenthesis issues
echo $src = "%INSTALLER_PATH%"                                           > "%PS_TEMP%"
echo $out = "%CHECKSUM_PATH%"                                           >> "%PS_TEMP%"
echo $h   = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash     >> "%PS_TEMP%"
echo $txt = "SHA256: " + $h + "  %INSTALLER_NAME%"                     >> "%PS_TEMP%"
echo [System.IO.File]::WriteAllText($out, $txt)                         >> "%PS_TEMP%"
echo Write-Host ("       SHA-256: " + $h)                               >> "%PS_TEMP%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_TEMP%"
del "%PS_TEMP%"
echo       Checksum saved to: dist\checksum.txt

:done
echo.
echo =============================================
echo   Build complete!
echo   Installer : dist\%INSTALLER_NAME%
echo   Checksum  : dist\checksum.txt
echo =============================================
echo.
pause