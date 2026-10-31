#Requires -Version 5.1
<#
.SYNOPSIS
  Install (or upgrade) ShockBox on the OBS host as C:\OBS\ShockBox.

.DESCRIPTION
  Idempotent: run it as often as you like. It stops what it replaces, copies the
  tree over the target (never deleting state or logs), removes the old
  "\ShockBox-Server" scheduled task if it is still registered, provisions the TUI
  supervisor's virtualenv, and puts "ShockBox.lnk" on the desktop.

  ShockBox is no longer started by a scheduled task or at logon. The TUI
  supervisor (tools\tui) owns the server process: it starts it, restarts it and
  stops it, and it keeps running after the TUI window is closed. The desktop
  shortcut is the way in. There is deliberately no auto-start at logon.

  It does not touch any other task, any other folder, and no running process it
  did not start itself. The old ErrorPopups-Server and LedWallAgent tasks are
  *not* removed here - retuning them is a separate, deliberate step (see
  deploy\README.md, "Retiring the old tasks").

.PARAMETER Target
  Install directory. Default C:\OBS\ShockBox.

.PARAMETER Source
  Repo checkout to copy from. Default: the parent of this script's folder.

.PARAMETER PythonExe
  Interpreter used to create the TUI virtualenv. Default: auto-detect py -3, then
  python3/python, requiring 3.11 or newer.

.PARAMETER WhatIf
  Print every write, copy and COM call without doing any of them. The read-only
  actions it still takes are checking that node.exe exists and probing for a
  Python to report.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1 -WhatIf

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
    [string]$Target = 'C:\OBS\ShockBox',
    [string]$Source,
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
    [string]$PythonExe,
    [int]$Port = 8972
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Step([string]$Message) { Write-Host "==> $Message" }
function Note([string]$Message) { Write-Host "    $Message" }

# ---- resolve the source tree -------------------------------------------------
if (-not $Source) { $Source = Split-Path -Parent $PSScriptRoot }
$Source = (Resolve-Path -LiteralPath $Source).Path
if (-not (Test-Path -LiteralPath (Join-Path $Source 'server.mjs'))) {
    throw "Not a ShockBox checkout: $Source has no server.mjs"
}

Step 'ShockBox install'
Note "source  $Source"
Note "target  $Target"
Note "node    $NodeExe"
Note "mode    TUI supervisor, desktop shortcut, no scheduled task, no logon start"

if (-not (Test-Path -LiteralPath $NodeExe)) {
    # Not fatal: run.cmd falls back to `node` on PATH. Say so rather than fail install.
    Write-Warning "node.exe not found at $NodeExe - a manual launch will fall back to 'node' on PATH"
}

# ---- 0. stop what this install is about to replace ---------------------------
# A copy over a live tree does not affect the running node (it already read its
# files), so the new code only takes effect after a restart. Restarting is the
# TUI's job now, but a stop still belongs here, before the copy: the tree must
# not be rewritten under a live server.
#
# Three things can be running the old code, and each is found by evidence:
#   1. the TUI supervisor, by its command line or by the pid in the supervisor
#      lock file. It is asked to shut down over its control path, not killed, so
#      it takes its server down in order.
#   2. the legacy run.cmd launcher loop (cmd.exe), by command line.
#   3. the node holding the port, only if its command line runs *our* server.mjs.
# The supervisor may have started the server through run.cmd, so 2 and 3 run
# after 1 either way - killing a child before its parent spares nothing.
function Get-ListenerPid([int]$Port) {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    } catch {
        return @()
    }
    return @($c | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-IsOurs([int]$ProcId, [string]$AppDir) {
    try {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcId" -ErrorAction Stop
    } catch {
        return $false
    }
    if (-not $p -or -not $p.CommandLine) { return $false }
    return ($p.CommandLine -match 'server\.mjs' -and $p.CommandLine -match [regex]::Escape($AppDir))
}

function Get-ProcessTable {
    # One WMI query for the whole stop, and never $null: StrictMode makes
    # assigning $null to something the code then iterates a trap.
    try {
        return @(Get-CimInstance Win32_Process -ErrorAction Stop)
    } catch {
        return @()
    }
}

function Get-SupervisorPid([string]$AppDir, $Table) {
    # Two independent pieces of evidence, because the TUI may be launched from a
    # venv path, from `python -m shockbox_tui`, or from a wrapper nobody expected.
    $found = @()
    foreach ($p in $Table) {
        if ($p.ProcessId -eq $PID) { continue }
        if (-not $p.CommandLine) { continue }
        $hitModule = $p.CommandLine -match 'shockbox_tui'
        $hitLock = $p.CommandLine -match 'supervisor\.lock'
        $hitApp = $p.CommandLine -match [regex]::Escape($AppDir)
        # "module and this install" is the strict form; the lock holder is trusted
        # for whichever install it names, since only that install wrote the file.
        if (($hitModule -and $hitApp) -or $hitLock) { $found += $p.ProcessId }
    }

    # The lock file names the owner as well; it survives a wrapper that rewrote
    # the command line, and it is the only handle when the process is a relaunch.
    $lock = Join-Path $env:LOCALAPPDATA 'ShockBox\runtime\supervisor.lock'
    if (Test-Path -LiteralPath $lock) {
        # A try/catch is not an expression in 5.1: assign inside the branches.
        $raw = ''
        try { $raw = [string](Get-Content -LiteralPath $lock -Raw -ErrorAction Stop) } catch { $raw = '' }
        foreach ($m in [regex]::Matches($raw, '\d+')) {
            $pid2 = 0
            if ([int]::TryParse($m.Value, [ref]$pid2) -and $pid2 -gt 0) {
                if ($Table | Where-Object { $_.ProcessId -eq $pid2 }) { $found += $pid2 }
            }
        }
    }
    return @($found | Select-Object -Unique)
}

function Send-SupervisorShutdown([string]$AppDir, $Table) {
    # Best effort and best-evidence: ask over the control path if the supervisor
    # publishes one, then wait briefly for the server it owns to let go of the
    # port. Never fatal - a supervisor that ignores the request is killed below.
    $pathFile = Join-Path $env:LOCALAPPDATA 'ShockBox\runtime\control.path'
    if (-not (Test-Path -LiteralPath $pathFile)) { return $false }
    $control = ([string](Get-Content -LiteralPath $pathFile -Raw -ErrorAction SilentlyContinue)).Trim()
    if (-not $control) { return $false }
    try {
        if ($control -match '^[A-Za-z]:\\' -or $control.StartsWith('\\')) {
            # A named pipe: a Win32 pipe name, no host part.
            $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', (Split-Path -Leaf $control), [System.IO.Pipes.PipeDirection]::InOut)
            $pipe.Connect(1500)
            $w = New-Object System.IO.StreamWriter($pipe)
            $w.WriteLine('shutdown')
            $w.Flush()
            $pipe.Dispose()
            return $true
        }
        if ($control -match '^(http|https)://') {
            Invoke-RestMethod -Method Post -Uri $control -Body '{"command":"shutdown"}' -ContentType 'application/json' -TimeoutSec 3 | Out-Null
            return $true
        }
        $uri = 'http://' + $control
        Invoke-RestMethod -Method Post -Uri $uri -Body '{"command":"shutdown"}' -ContentType 'application/json' -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        Write-Warning "supervisor control path $control did not accept a shutdown: $($_.Exception.Message)"
        return $false
    }
}

Step 'stop'
$stopped = @()
$AppDir = $Target
if ($PSCmdlet.ShouldProcess($AppDir, 'stop the TUI supervisor, the run.cmd launcher loop and the node serving the port')) {
    $table = Get-ProcessTable

    # 1. the TUI supervisor: ask, then insist.
    $sup = @(Get-SupervisorPid $AppDir $table)
    if ($sup.Count -gt 0) {
        Note ("TUI supervisor running as pid " + ($sup -join ', '))
        if (Send-SupervisorShutdown $AppDir $table) {
            Note 'asked the supervisor to shut down'
            for ($i = 0; $i -lt 20; $i++) {
                if (-not ($sup | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })) { break }
                Start-Sleep -Milliseconds 250
            }
        }
        foreach ($s in $sup) {
            if (Get-Process -Id $s -ErrorAction SilentlyContinue) {
                Stop-Process -Id $s -Force -ErrorAction SilentlyContinue
                Note "stopped supervisor pid $s"
                $stopped += "supervisor $s"
            } else {
                Note "supervisor pid $s exited on request"
                $stopped += "supervisor $s"
            }
        }
    } else {
        Note 'no TUI supervisor running'
    }

    # 2. the legacy launcher loop (cmd.exe) survives its parent, and its child
    # node is the process holding the port. Kill the loop first, or node comes
    # back. Lazily-evaluated because the target's cmd may run from a copied folder
    # whose path differs only by case (it does: 'shockbox' vs 'ShockBox').
    $loops = @(Get-ProcessTable | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine -match 'run\.cmd' -and $_.CommandLine -match [regex]::Escape($AppDir) })
    foreach ($loop in $loops) {
        Stop-Process -Id $loop.ProcessId -Force -ErrorAction SilentlyContinue
        Note "stopped launcher pid $($loop.ProcessId)"
        $stopped += "launcher $($loop.ProcessId)"
    }

    # 3. the port's listener, under the evidence rule.
    foreach ($listener in @(Get-ListenerPid $Port)) {
        if (Test-IsOurs $listener $AppDir) {
            Stop-Process -Id $listener -Force -ErrorAction SilentlyContinue
            Note "stopped server pid $listener (port $Port)"
            $stopped += "server $listener"
        } elseif ($listener -eq 4) {
            Write-Warning "port $Port is held by the HTTP.sys service (pid 4), not ShockBox - leaving it"
        } else {
            $line = (Get-CimInstance Win32_Process -Filter "ProcessId = $listener" -ErrorAction SilentlyContinue).CommandLine
            Write-Warning "port $Port is held by pid $listener which is not this install ($line) - leaving it; the next start will report EADDRINUSE"
        }
    }

    if ($stopped.Count -eq 0) { Note 'nothing was running' }
    Start-Sleep -Milliseconds 700
} else {
    Note 'send "shutdown" to the TUI supervisor (command line shockbox_tui, or the %LOCALAPPDATA%\ShockBox\runtime\supervisor.lock holder);'
    Note "then stop the run.cmd launcher loop and the node serving $Port (only if its command line runs $AppDir\server.mjs)"
}

# ---- 1. directories ----------------------------------------------------------
# state\ and logs\ are created here as well as by run.cmd, so the first copy
# never races the first start for them, and -WhatIf still describes the full set.
foreach ($sub in @('', 'state', 'logs', 'backups')) {
    $dir = if ($sub) { Join-Path $Target $sub } else { $Target }
    if ($PSCmdlet.ShouldProcess($dir, 'create directory')) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
}

# ---- 2. copy the tree --------------------------------------------------------
# Robocopy rather than Copy-Item: it handles long paths and returns meaningful
# exit codes (0-7 = success; 8+ = failure). NOT /MIR: mirrors would delete the
# live state and logs sitting in the target. .tui-venv is excluded on the source
# side so a checkout that has one never copies its absolute paths onto the rig.
$excludedDirs = @('.git', 'state-dev', 'node_modules', 'backups', '.cocoindex_code', '.openchamber', '.opencode', '.cortexkit', 'captures', '.tui-venv')
$excludedFiles = @('*.log', '*.log.1', 'config.json', 'config.local.json')

# One /XD and one /XF, each followed by its own list: repeated switches re-parse
# differently from run to run, a single switch with a list is stable. The source's
# .git and the target's state/logs are separate /XD lists, chained by name too.
$roboArgs = @(
    $Source, $Target,
    '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:2', '/NJH', '/NJS', '/NP', '/NDL', '/XJ',
    '/XF') + $excludedFiles
$roboArgs += @('/XD') + ($excludedDirs | ForEach-Object { Join-Path $Source $_ }) +
             @((Join-Path $Target 'state'), (Join-Path $Target 'logs'), (Join-Path $Target 'backups'))

if ($PSCmdlet.ShouldProcess($Target, 'copy the tree (robocopy /E, excluding .git state-dev node_modules backups .tui-venv)')) {
    Step 'copy'
    & robocopy.exe @roboArgs | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) { throw "robocopy failed with exit code $code" }
    Note "robocopy exit $code"
} else {
    Step 'copy (WhatIf)'
    Note ("robocopy " + ($roboArgs -join ' '))
}

# ---- 3. migrate off the scheduled task ---------------------------------------
# ShockBox used to be started by a logon task. It is not any more, and an old
# registration left behind would start a second server at the next logon and
# fight the TUI for the port. Ended, then unregistered; idempotent.
# Scoped by name on purpose: ErrorPopups-Server and LedWallAgent stay untouched.
$LegacyTask = 'ShockBox-Server'
Step "task (migrate)"
$legacy = Get-ScheduledTask -TaskName $LegacyTask -ErrorAction SilentlyContinue
if ($legacy) {
    if ($PSCmdlet.ShouldProcess("\$LegacyTask", 'end and unregister the old scheduled task')) {
        schtasks.exe /End /TN $LegacyTask | Out-Null
        Note 'legacy task ended'
        Unregister-ScheduledTask -TaskName $LegacyTask -Confirm:$false
        Note "migrated: removed scheduled task $LegacyTask"
    } else {
        Note "schtasks /End /TN $LegacyTask ; Unregister-ScheduledTask -TaskName $LegacyTask -Confirm:`$false  # migrated: removed scheduled task $LegacyTask"
    }
} else {
    Note "migrated: no $LegacyTask task registered (nothing to remove)"
}

# ---- 4. the TUI supervisor's virtualenv --------------------------------------
# The app runs without Python; only the TUI needs it. So a missing interpreter is
# a loud warning, never a failed install.
function Find-Python {
    param([string]$Explicit)
    $candidates = @()
    if ($Explicit) {
        $candidates += , @($Explicit, @())
    } else {
        $py = Get-Command py.exe -ErrorAction SilentlyContinue
        $py3 = Get-Command python3.exe -ErrorAction SilentlyContinue
        # A WindowsApps python3.exe is the Store alias and says "not found" when
        # run; probing it would produce one warning per candidate for nothing.
        if ($py3 -and $py3.Source -match '\\WindowsApps\\') { $py3 = $null }
        $python = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($py) { $candidates += , @($py.Source, @('-3')) }
        if ($py3) { $candidates += , @($py3.Source, @()) }
        if ($python) { $candidates += , @($python.Source, @()) }
    }
    foreach ($cand in $candidates) {
        $exe = [string]$cand[0]
        $pre = @($cand[1])
        try {
            $out = @(& $exe @pre '--version' 2>&1)
            $text = ($out | ForEach-Object { [string]$_ }) -join ' '
        } catch {
            continue
        }
        if ($text -notmatch 'Python\s+(\d+)\.(\d+)') { continue }
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        if ($major -lt 3) { continue }
        if ($major -eq 3 -and $minor -lt 11) { Write-Warning "$exe is Python $major.$minor; the TUI needs 3.11 or newer"; continue }
        return [pscustomobject]@{ Exe = $exe; Prefix = $pre; Version = "$major.$minor" }
    }
    return $null
}

Step 'python (TUI)'
$Venv = Join-Path $Target '.tui-venv'
$TuiDir = Join-Path $Target 'tools\tui'
$Reinstall = 'pwsh -NoProfile -Command "deploy\install.ps1" (or: powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1)'
$pyFound = Find-Python -Explicit $PythonExe
if (-not $pyFound) {
    Write-Warning 'no Python 3.11+ found (py -3, python3, python) - the TUI is unavailable, the ShockBox app itself is unaffected'
    Note 'to get the TUI: install Python 3.11+ (winget install --id Python.Python.3.12 -e), then re-run:'
    Note "  $Reinstall"
} else {
    Note ("python  $($pyFound.Exe) $($pyFound.Version)")
    $venvPy = Join-Path $Venv 'Scripts\python.exe'
    $created = $false
    if (-not (Test-Path -LiteralPath $venvPy)) {
        if ($PSCmdlet.ShouldProcess($Venv, 'create the TUI virtualenv')) {
            & $pyFound.Exe @($pyFound.Prefix) -m venv $Venv | Out-Null
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPy)) {
                throw "venv creation failed with exit code $LASTEXITCODE ($Venv)"
            }
            $created = $true
            Note "created $Venv"
        } else {
            Note "$($pyFound.Exe) $($pyFound.Prefix -join ' ') -m venv $Venv"
        }
    } else {
        Note "venv    $Venv (present)"
    }

    if (-not (Test-Path -LiteralPath $TuiDir)) {
        Write-Warning "TUI sources not found: $TuiDir - the venv is ready but shockbox_tui is not installed"
        Note "re-run this installer once tools\tui exists: $Reinstall"
    } elseif ($PSCmdlet.ShouldProcess($TuiDir, 'pip install -e tools\tui into the TUI virtualenv')) {
        & $venvPy -m pip install --no-input --disable-pip-version-check -e $TuiDir
        if ($LASTEXITCODE -ne 0) { Write-Warning "pip install -e tools\tui failed with exit code $LASTEXITCODE - the TUI may not start" }
        else { Note "installed shockbox_tui (editable) into $Venv" }
    } else {
        Note "`"$venvPy`" -m pip install --no-input --disable-pip-version-check -e $TuiDir"
    }

    Note "venv python  $venvPy"
}

# ---- 5. the icon -------------------------------------------------------------
# The shortcut must always have one: an .ico from deploy\ or the repo root if the
# project ships one, otherwise a deterministic LED-grid mark drawn here. Copied or
# generated into the target's deploy\ so the shortcut never points at a source.
Step 'icon'
$IconTarget = Join-Path $Target 'deploy\shockbox.ico'
$iconSource = $null
if (Test-Path -LiteralPath (Join-Path $Source 'deploy\shockbox.ico')) {
    $iconSource = Join-Path $Source 'deploy\shockbox.ico'
} elseif (Test-Path -LiteralPath (Join-Path $Source 'shockbox.ico')) {
    $iconSource = Join-Path $Source 'shockbox.ico'
}

function New-ShockBoxIcon([string]$Path) {
    # Deterministic, dependency-free: a 16x16 LED grid on a dark rounded tile,
    # rendered at 16/32/48/256 and packed as a multi-size .ico. Only the 256 entry
    # is PNG-compressed (BMP entries at 256 would be ~256 KB of padding); the
    # small ones are 32-bit BMP DIBs, which every Windows shell reads.
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $grid = @(
        '................',
        '.....######.....',
        '....#......#....',
        '...#..#..#..#...',
        '...#.##.##..#...',
        '...#..#..#..#...',
        '....#......#....',
        '.....######.....',
        '................',
        '..##..##..##..##',
        '..##..##..##..##',
        '................',
        '..##########....',
        '..#........#....',
        '..##########....',
        '................'
    )
    if ($grid.Count -ne 16) { throw 'icon grid must be 16 rows' }
    foreach ($row in $grid) { if ($row.Length -ne 16) { throw 'icon grid rows must be 16 columns' } }

    $batches = @()
    foreach ($size in @(16, 32, 48, 256)) {
        $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $g.Clear([System.Drawing.Color]::FromArgb(255, 17, 22, 28))
        $on = [System.Drawing.Color]::FromArgb(255, 255, 106, 31)
        $cell = [double]$size / 16.0
        for ($y = 0; $y -lt 16; $y++) {
            for ($x = 0; $x -lt 16; $x++) {
                if ($grid[$y][$x] -ne '#') { continue }
                $b = New-Object System.Drawing.SolidBrush($on)
                # Inset by a hair so neighbouring cells read as separate LEDs.
                $g.FillRectangle($b, [single]($x * $cell), [single]($y * $cell), [single]$cell, [single]$cell)
                $b.Dispose()
            }
        }
        $g.Dispose()

        $ms = New-Object System.IO.MemoryStream
        if ($size -eq 256) {
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $payload = $ms.ToArray()
            $batches += , @{ Size = $size; Bytes = $payload; Png = $true }
        } else {
            # 32-bit DIB: BITMAPINFOHEADER with height doubled (XOR + AND mask),
            # BGRA rows bottom-up, then a zeroed 1bpp mask padded to 4-byte rows.
            $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
            $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $stride = $data.Stride
            $raw = New-Object byte[] ($stride * $size)
            [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
            $bmp.UnlockBits($data)
            $bw = New-Object System.IO.BinaryWriter($ms)
            $bw.Write([int]40); $bw.Write([int]$size); $bw.Write([int]($size * 2))
            $bw.Write([int16]1); $bw.Write([int16]32); $bw.Write([int]0)
            $bw.Write([int]($size * $size * 4)); $bw.Write([int]0); $bw.Write([int]0); $bw.Write([int]0); $bw.Write([int]0)
            for ($row = $size - 1; $row -ge 0; $row--) { $bw.Write($raw, $row * $stride, $size * 4) }
            $maskStride = [math]::Floor(($size + 31) / 32) * 4
            $bw.Write((New-Object byte[] ($maskStride * $size)))
            $bw.Flush()
            $batches += , @{ Size = $size; Bytes = $ms.ToArray(); Png = $false }
        }
        $ms.Dispose()
        $bmp.Dispose()
    }

    $out = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter($out)
    $w.Write([int16]0); $w.Write([int16]1); $w.Write([int16]$batches.Count)
    $offset = 6 + (16 * $batches.Count)
    foreach ($b in $batches) {
        $dim = if ($b.Size -ge 256) { 0 } else { $b.Size }
        $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
        $w.Write([int16]1); $w.Write([int16]32)
        $w.Write([int]$b.Bytes.Length); $w.Write([int]$offset)
        $offset += $b.Bytes.Length
    }
    foreach ($b in $batches) { $w.Write($b.Bytes) }
    $w.Flush()
    [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
    $w.Dispose()
    $out.Dispose()
}

if ($iconSource) {
    if ($PSCmdlet.ShouldProcess($IconTarget, "copy $iconSource")) {
        Copy-Item -LiteralPath $iconSource -Destination $IconTarget -Force
        Note "copied $iconSource"
    } else {
        Note "Copy-Item -LiteralPath $iconSource -Destination $IconTarget -Force"
    }
} else {
    if ($PSCmdlet.ShouldProcess($IconTarget, 'generate a 16/32/48/256 LED-grid .ico')) {
        New-ShockBoxIcon -Path $IconTarget
        Note "generated $IconTarget"
    } else {
        Note "generate 256/48/32/16 LED-grid icon -> $IconTarget (System.Drawing)"
    }
}

# ---- 6. the desktop shortcut -------------------------------------------------
# This is the entry point. Nothing auto-starts at logon any more: whoever wants
# ShockBox running starts it here, and the supervisor keeps it running afterwards.
Step 'shortcut'
$DesktopDir = [Environment]::GetFolderPath('Desktop')
$LnkPath = Join-Path $DesktopDir 'ShockBox.lnk'
$Launcher = Join-Path $Target 'deploy\ShockBox-TUI.cmd'
if (Test-Path -LiteralPath $Launcher) {
    if ($PSCmdlet.ShouldProcess($LnkPath, 'create the desktop shortcut (WScript.Shell)')) {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($LnkPath)
        $lnk.TargetPath = $Launcher
        $lnk.WorkingDirectory = $Target
        $lnk.IconLocation = $IconTarget
        $lnk.Description = 'ShockBox - TUI supervisor'
        $lnk.WindowStyle = 7
        $lnk.Save()
        Note "created $LnkPath"
        Note "         -> $Launcher"
    } else {
        Note "`$s = New-Object -ComObject WScript.Shell; `$l = `$s.CreateShortcut('$LnkPath'); `$l.TargetPath='$Launcher'; `$l.WorkingDirectory='$Target'; `$l.IconLocation='$IconTarget'; `$l.WindowStyle=7; `$l.Save()"
    }
} else {
    Write-Warning "launcher not found: $Launcher - no shortcut created; re-run the installer from a checkout that has deploy\ShockBox-TUI.cmd"
}

Step 'done'
Note 'no auto-start at logon: start ShockBox from the desktop shortcut "ShockBox"'
Note "logs:   $Target\logs"
Note "state:  $Target\state"
Note 'no scheduled task is registered; the TUI supervisor owns the server process'
