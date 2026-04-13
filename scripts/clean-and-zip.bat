@echo off
setlocal

echo =============================================
echo  Foldr - Clean and Zip for Distribution
echo =============================================
echo.

:: Move up to project root (scripts\ is one level down)
cd /d "%~dp0.."

set PROJECT_DIR=%CD%
set PARENT_DIR=%CD%\..
set ZIP_NAME=foldr-dist-%DATE:~-4%-%DATE:~3,2%-%DATE:~0,2%.zip

echo Project folder: %PROJECT_DIR%
echo Output zip:     %PARENT_DIR%\%ZIP_NAME%
echo.

:: ── Delete generated folders ──────────────────
echo [1/3] Cleaning generated folders...

if exist "node_modules"              ( rd /s /q "node_modules"              && echo   removed node_modules )
if exist "frontend\node_modules"     ( rd /s /q "frontend\node_modules"     && echo   removed frontend\node_modules )
if exist "frontend\build"            ( rd /s /q "frontend\build"            && echo   removed frontend\build )
if exist "backend\dist"              ( rd /s /q "backend\dist"              && echo   removed backend\dist )
if exist "backend\build"             ( rd /s /q "backend\build"             && echo   removed backend\build )
if exist "dist"                      ( rd /s /q "dist"                      && echo   removed dist )

echo   Done.
echo.

:: ── Zip ───────────────────────────────────────
echo [2/3] Creating zip...

:: Use PowerShell to create the zip (no 3rd party tools needed)
powershell -NoProfile -Command ^
  "Compress-Archive -Path '%PROJECT_DIR%' -DestinationPath '%PARENT_DIR%\%ZIP_NAME%' -Force"

if %errorlevel% neq 0 (
    echo ERROR: Zip failed.
    pause
    exit /b 1
)

echo   Done.
echo.

:: ── Summary ───────────────────────────────────
echo [3/3] Summary
echo.
echo   Zip created at:
echo   %PARENT_DIR%\%ZIP_NAME%
echo.

:: Show file size
powershell -NoProfile -Command ^
  "$f = Get-Item '%PARENT_DIR%\%ZIP_NAME%'; Write-Host ('   Size: ' + [math]::Round($f.Length/1MB,2) + ' MB')"

echo.
echo   The receiving developer just needs to run:
echo   scripts\dev.bat
echo.
echo =============================================
pause