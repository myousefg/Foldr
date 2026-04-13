@echo off
setlocal
cd /d "%~dp0.."

echo =============================================
echo  Foldr - Dev
echo =============================================
echo.

echo [1/3] Installing root Node deps...
call npm install --loglevel=error --no-fund --no-audit
if %errorlevel% neq 0 ( echo ERROR: npm install failed & pause & exit /b 1 )

echo [2/3] Installing frontend deps...
cd frontend
call yarn install --silent 2>nul
cd ..
if %errorlevel% neq 0 ( echo ERROR: yarn install failed & pause & exit /b 1 )

echo [3/3] Installing Python backend deps...
python -m pip install -r backend\requirements.txt -q --disable-pip-version-check
if %errorlevel% neq 0 (
    py -m pip install -r backend\requirements.txt -q --disable-pip-version-check
)

echo.
echo =============================================
echo  Starting Foldr
echo  React   : http://localhost:3000
echo  Backend : http://localhost:8765
echo =============================================
echo.

set NODE_NO_WARNINGS=1
set NODE_OPTIONS=--no-deprecation
npm start --silent