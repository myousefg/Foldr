@echo off
echo === Foldr .exe Build ===
echo.
echo [1/3] Bundle Python backend with PyInstaller...
cd backend
pip install pyinstaller
pyinstaller foldr_backend.spec --clean --noconfirm
cd ..
echo [2/3] Build React frontend...
cd frontend
call yarn build
cd ..
echo [3/3] Package with electron-builder (NSIS installer)...
call npm install
call npm run dist
echo.
echo === Done! ===
echo Installer is at:  dist\Foldr Setup 1.0.0.exe
pause
