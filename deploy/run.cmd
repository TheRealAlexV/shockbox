@echo off
rem ===========================================================================
rem  ShockBox launcher - the one place the server is started on the rig.
rem
rem  Called by deploy\start-hidden.vbs, which the "\ShockBox-Server" scheduled
rem  task runs at logon (hidden, no console). This script owns the restart loop:
rem  node exits for any reason, cmd sleeps, and node comes back.
rem
rem  Deliberately a .cmd and not a relaunch of the task: a task started with S4U
rem  has no interactive token, so it cannot use the Task Scheduler API - a
rem  `schtasks /run` from inside it would need a password the task does not have.
rem  cmd needs none, and the loop therefore survives both a crash and a logon.
rem
rem  Logs: logs\shockbox-YYYY-MM-DD.log      (the app's own log stream)
rem        logs\launcher-YYYY-MM-DD.log     (this loop: starts, exit codes, waits)
rem  The launcher prunes this folder once per process, before its first start:
rem  keeps the 4 newest shockbox-* / launcher-* files, truncates the rest to zero
rem  if the folder is still over 64 MB. A long-lived process is covered by the
rem  app's own 15 minute prune in server.mjs, and the app's writer rotates per
rem  file, so this only has to close the case where the app never starts.
rem  Backoff: 2s, 4s, 8s, 16s, 30s, 60s, then 60s while crashes keep coming
rem  within 5 minutes of each other. A run that lasts 5 minutes resets it.
rem ===========================================================================
setlocal EnableExtensions DisableDelayedExpansion

rem --- where things live ------------------------------------------------------
set "APP=%~dp0.."
for %%I in ("%APP%") do set "APP=%%~fI"
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set "PORT=8972"
set "STATE=%APP%\state"
set "LOGS=%APP%\logs"
set "SOUNDS=C:\OBS\Sounds\SoundBoard"

rem --- locals -----------------------------------------------------------------
if not exist "%STATE%" mkdir "%STATE%" 2>nul
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul

set "BACKOFF=2"
set "FIVEMIN=300"

rem PowerShell 5.1 ships with Windows and install.ps1 already depends on it. If it is
rem missing the prune is skipped, which costs nothing but space.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS="

:loop
rem A fresh clock per attempt: a run that beats it is healthy and resets backoff.
call :stamp
set "STARTED=%STAMP%"

call :stamp
set "LOGFILE=%LOGS%\shockbox-%STAMP:~0,10%.log"
>>"%LOGFILE%" echo %date% %time% launcher: start "node server.mjs --port %PORT%"

rem The one command line. >> rather than > so a restart appends to the same day.
rem Prune once per cmd process, not once per attempt. A crash loop is bounded here, and
rem a long-lived process is covered by the app's own 15 minute prune in server.mjs. The
rem case this exists for is the app never starting, and that case restarts node, not
rem cmd, so one prune per process is exactly the right amount.
if not defined PRUNED call :doprune
set "PRUNED=1"
pushd "%APP%"
"%NODE%" server.mjs --port %PORT% --state "%STATE%" --log-dir "%LOGS%" --sounds "%SOUNDS%" 1>>"%LOGFILE%" 2>&1
popd
set "EXITCODE=%ERRORLEVEL%"

call :stamp
set "ENDED=%STAMP%"
call :elapsed %STARTED% %ENDED%
if %ELAPSED% GEQ %FIVEMIN% set "BACKOFF=2"

>>"%LOGS%\launcher-%STAMP:~0,10%.log" echo %date% %time% exited %EXITCODE% after %ELAPSED%s, restarting in %BACKOFF%s
rem The launcher log is where a crash loop is visible even when the app died before
rem opening its own log: the exit code and how long it lived are both here.

set /a NEXT=BACKOFF * 2
if %NEXT% GTR 60 set "NEXT=60"
set "BACKOFF=%NEXT%"

rem `timeout` refuses to run with stdin redirected (it is, under wscript), so the
rem wait is a ping against loopback: same effect, works with no console.
ping -n %BACKOFF% 127.0.0.1 >nul 2>&1
goto loop

rem ===========================================================================
rem  helpers
rem
rem  The clock is the local one (`%time%`), read as HH, MM and SS by offset. The
rem  `1` prefix turns each segment into a number cmd will not read as octal, so
rem  `08` and `09` are 8 and 9 rather than errors. Quotes are deliberately not
rem  used in these calls: a quoted value would carry its quotes into the string
rem  slicing. The file uses no delayed expansion and no arithmetic inside a
rem  parenthesised block, which is where batch clocks usually break.
rem ===========================================================================

:stamp
rem YYYY-MM-DD (local) into STAMP - used in file names.
set "STAMP=%date:~-4%-%date:~4,2%-%date:~7,2%"
goto :eof

:elapsed
rem ELAPSED = whole seconds between two "HH:MM:SS.ms" local times.
call :secs %1
set "T1=%SECS%"
call :secs %2
set "T2=%SECS%"
set /a ELAPSED=T2 - T1
if %ELAPSED% LSS 0 set /a ELAPSED=ELAPSED + 86400
goto :eof

:secs
rem SECS = H*3600 + M*60 + S from a time string.
set "CLOCK=%1"
set /a SECS=(1%CLOCK:~0,2% - 100)*3600 + (1%CLOCK:~3,2% - 100)*60 + (1%CLOCK:~6,2% - 100)
goto :eof

:doprune
rem Only once per cmd process: PRUNED in the loop body makes the second visit skip
rem this. It can never take the launcher down either - PS is resolved before the loop
rem and left empty when absent, and the redirection swallows whatever it says.
rem mtime decides what is newest, so nothing here reads a date out of a filename; wmic is
rem not an option because Windows 11 24H2 does not have it.
rem The app cannot see this cleanup: Remove-Item on a file whose handle is still open fails
rem silently, which is why every operation is -ErrorAction SilentlyContinue. A
rem locked file just keeps the folder over the ceiling for one more cycle.
if not defined PS goto :eof
rem STAMP is set by :loop above. -Command is one argument, so its quoting stays as written.
"%PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$d='%LOGS%'; $f=@(Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'shockbox-*' -or $_.Name -like 'launcher-*' } | Sort-Object LastWriteTime -Descending); $keep=$f | Select-Object -First 4; $f | Where-Object { $keep -notcontains $_ } | Remove-Item -Force -ErrorAction SilentlyContinue; $t=($keep | Measure-Object Length -Sum).Sum; if ($t -gt 64MB) { $keep | Sort-Object LastWriteTime | Select-Object -First 3 | ForEach-Object { try { [System.IO.File]::WriteAllText($_.FullName,'') } catch {} } }" >>"%LOGS%\launcher-%STAMP:~0,10%.log" 2>&1
goto :eof

