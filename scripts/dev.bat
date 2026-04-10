@echo off
echo =============================================
echo  Foldr - Dev Setup
echo =============================================
echo.

echo [1/3] Installing root Node deps...
call npm install
if %errorlevel% neq 0 ( echo ERROR: npm install failed & pause & exit /b 1 )

echo.
echo [2/3] Installing frontend deps...
cd frontend
call yarn install
cd ..
if %errorlevel% neq 0 ( echo ERROR: yarn install failed & pause & exit /b 1 )

echo.
echo [3/3] Installing Python backend deps...
python -m pip install -r backend\requirements.txt
if %errorlevel% neq 0 (
    echo Trying 'py' instead of 'python'...
    py -m pip install -r backend\requirements.txt
)

echo.
echo =============================================
echo  Starting Foldr (React + Electron)
echo  - React dev server: http://localhost:3000
echo  - Python backend:   http://localhost:8765
echo  - Electron window opens automatically
echo =============================================
echo.

set NODE_ENV=development
npm start
