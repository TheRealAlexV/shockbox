@echo off
rem ===========================================================================
rem  ShockBox TUI - what the desktop shortcut "ShockBox.lnk" runs.
rem
rem  This is the ONLY supported way to start ShockBox by hand: it opens the
rem  supervisor TUI, which starts, restarts and stops the server for you. Do
rem  not start the server with deploy\run.cmd any more; that file is kept for
rem  manual/legacy launches only.
rem
rem  The TUI runs from its own virtualenv, .tui-venv in the app folder, which
rem  deploy\install.ps1 provisions (pip install -e tools\tui). If it is missing
rem  this window says exactly how to make it and waits, so it does not vanish.
rem
rem  All arguments are passed through, e.g.  ShockBox-TUI.cmd --help
rem ===========================================================================
setlocal EnableExtensions
title ShockBox TUI
chcp 65001 >nul 2>&1

rem --- where things live ------------------------------------------------------
rem deploy\.. is the app folder (the folder above this file), whatever it is.
set "APP=%~dp0.."
for %%I in ("%APP%") do set "APP=%%~fI"
set "VENVPY=%APP%\.tui-venv\Scripts\python.exe"

rem --- no venv: say how to make one, and stay visible ------------------------
if not exist "%VENVPY%" goto :novenv

cd /d "%APP%"
rem --app-dir is the folder holding server.mjs, which is the app folder itself - not
rem its deploy\ subfolder. Passing deploy\ makes the TUI exit with "no server.mjs".
"%VENVPY%" -m shockbox_tui --app-dir "%APP%" %*
set "RC=%ERRORLEVEL%"
exit /b %RC%

:novenv
echo.
echo   ShockBox TUI is not installed in this folder:
echo     %APP%\.tui-venv
echo.
echo   Install it, from the app folder, with:
echo     py -3 -m venv .tui-venv
echo     .tui-venv\Scripts\python.exe -m pip install --no-input -e tools\tui
echo.
echo   Or re-run the installer, which does both and the shortcut too:
echo     powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1
echo.
pause
exit /b 1
