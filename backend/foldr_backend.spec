# PyInstaller spec — run: pyinstaller foldr_backend.spec
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

a = Analysis(
    ['server.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=(
        collect_submodules('uvicorn') +
        collect_submodules('fastapi') +
        collect_submodules('watchdog') +
        ['uvicorn.logging','uvicorn.loops','uvicorn.loops.auto',
         'uvicorn.protocols','uvicorn.protocols.http',
         'uvicorn.protocols.http.auto','uvicorn.protocols.websockets',
         'uvicorn.protocols.websockets.auto','uvicorn.lifespan',
         'uvicorn.lifespan.on']
    ),
    hookspath=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.zipfiles, a.datas,
    name='foldr-backend',
    debug=False, bootloader_ignore_signals=False,
    strip=False, upx=True,
    console=False,   # no console window
    onefile=True,
)
