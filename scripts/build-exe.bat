@echo off
setlocal EnableDelayedExpansion

:: ============================================================
::  Foldr — Windows Build Script
::  Produces: dist\Foldr-Setup-<VERSION>.exe + checksum.txt
::
::  HOW TO CHANGE THE VERSION
::  --------------------------
::  1. Update APP_VERSION below (e.g. 1.1.0)
::  2. Update "version" in package.json to match
::  3. Update filevers/prodvers in backend\version_info.txt to match
::     e.g. v1.1.0  →  filevers=(1, 1, 0, 0)
::  That's it. All three places must stay in sync.
:: ============================================================

set APP_VERSION=1.1.0
set INSTALLER_NAME=Foldr-Setup-%APP_VERSION%.exe
set DIST_DIR=%~dp0..\dist

echo.
echo ╔══════════════════════════════════════╗
echo ║     Foldr Build  v%APP_VERSION%             ║
echo ╚══════════════════════════════════════╝
echo.

:: ── Step 1: Python backend → foldr-backend.exe ──────────────
echo [1/4] Building Python backend with PyInstaller...
cd /d "%~dp0..\backend"
pip install pyinstaller --quiet
pyinstaller foldr_backend.spec --clean --noconfirm
if errorlevel 1 (
    echo ERROR: PyInstaller failed. Aborting.
    pause & exit /b 1
)
echo       Done. Output: backend\dist\foldr-backend.exe
echo.

:: ── Step 2: React frontend ───────────────────────────────────
echo [2/4] Building React frontend...
cd /d "%~dp0..\frontend"
call yarn build
if errorlevel 1 (
    echo ERROR: React build failed. Aborting.
    pause & exit /b 1
)
echo       Done. Output: frontend\build\
echo.

:: ── Step 3: Electron-builder NSIS installer ─────────────────
echo [3/4] Packaging installer with electron-builder...
cd /d "%~dp0.."
call npm install --silent
call npm run dist
if errorlevel 1 (
    echo ERROR: electron-builder failed. Aborting.
    pause & exit /b 1
)
echo       Done. Output: dist\%INSTALLER_NAME%
echo.

:: ── Step 4: SHA-256 checksum ─────────────────────────────────
echo [4/4] Generating SHA-256 checksum...
if not exist "%DIST_DIR%\%INSTALLER_NAME%" (
    echo WARNING: Installer not found at dist\%INSTALLER_NAME% — skipping checksum.
) else (
    powershell -NoProfile -Command ^
        "$h = (Get-FileHash '%DIST_DIR%\%INSTALLER_NAME%' -Algorithm SHA256).Hash;" ^
        "Set-Content -Path '%DIST_DIR%\checksum.txt' -Value \"SHA256: $h  %INSTALLER_NAME%\";" ^
        "Write-Host \"       SHA-256: $h\""
    echo       Checksum saved to: dist\checksum.txt
)
echo.

echo ╔══════════════════════════════════════════════════════╗
echo ║  Build complete!                                     ║
echo ║  Installer : dist\%INSTALLER_NAME%      ║
echo ║  Checksum  : dist\checksum.txt                       ║
echo ╚══════════════════════════════════════════════════════╝
echo.
pause
