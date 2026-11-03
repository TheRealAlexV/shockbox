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
  Repo checkout to copy from. Default: the parent of this script's folder. A
  \\wsl.localhost (or \\wsl$) path is fine: it is normalised, and the tree is
  copied with Copy-Item instead of robocopy, which rejects the WSL share's
  provider-qualified form with exit 16.

.PARAMETER PythonExe
  Interpreter used to create the TUI virtualenv. Default: auto-detect py -3, then
  python3/python, requiring 3.11 or newer.

.PARAMETER WhatIf
  Print every write, copy and COM call without doing any of them. The read-only
  actions it still takes are checking that node.exe exists, probing for a Python
  to report, and surveying the running processes it would stop - the survey names
  each matched pid and command line, so this is a real dry run.

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

# The survey below runs even under -WhatIf, so CimCmdlets gets autoloaded inside a WhatIf
# scope: Import-Module then reports creating each of its gcim/scim aliases, 13 lines of noise
# in the middle of the dry run. Load it once with WhatIf off; the cmdlets stay available.
if ($WhatIfPreference) {
    $WhatIfPreference = $false
    Import-Module CimCmdlets -ErrorAction SilentlyContinue
    Import-Module NetTCPIP -ErrorAction SilentlyContinue
    $WhatIfPreference = $true
}

function Step([string]$Message) { Write-Host "==> $Message" }
function Note([string]$Message) { Write-Host "    $Message" }

function Resolve-SourcePath([string]$Path) {
    # Resolve-Path on a UNC path hands back a provider-qualified string
    # ('Microsoft.PowerShell.Core\FileSystem::\\wsl.localhost\...'), and robocopy rejects that
    # with exit 16, "The specified path is invalid", copying nothing. FullName never carries
    # the provider prefix; the replace also cleans a path pasted back out of an error message.
    $resolved = $Path
    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($item) { $resolved = $item.FullName }
    return ($resolved -replace '^Microsoft\.PowerShell\.Core\\FileSystem::', '')
}

function Test-WslUncPath([string]$Path) {
    # A WSL share (\\wsl.localhost\Ubuntu, \\wsl$, \\wsl) is not a real SMB share: robocopy
    # only ever saw it in the provider-qualified form that it rejects with exit 16. So a WSL
    # source takes the Copy-Item path, which goes through the ordinary Win32 file API - see
    # Copy-TreeFallback.
    return ($Path -match '^\\\\wsl(\$|\.localhost)?\\')
}

function Copy-TreeFallback([string]$From, [string]$To, [string[]]$SkipDirs, [string[]]$SkipFiles) {
    # The robocopy line, without robocopy: same excluded directories and files, recursion done
    # here because Copy-Item -Recurse cannot filter what it descends into (a nested .venv would
    # be copied and its Linux symlinks fail on Windows). Never a mirror: nothing in the target
    # is deleted.
    if (-not (Test-Path -LiteralPath $To)) { New-Item -ItemType Directory -Force -Path $To | Out-Null }
    foreach ($child in @(Get-ChildItem -LiteralPath $From -Force)) {
        $name = $child.Name
        if ($child.PSIsContainer) {
            if ($SkipDirs -contains $name) { continue }
            Copy-TreeFallback -From $child.FullName -To (Join-Path $To $name) -SkipDirs $SkipDirs -SkipFiles $SkipFiles
        } else {
            if (@($SkipFiles | Where-Object { $name -like $_ }).Count -gt 0) { continue }
            Copy-Item -LiteralPath $child.FullName -Destination (Join-Path $To $name) -Force
        }
    }
}

# ---- resolve the source tree -------------------------------------------------
if (-not $Source) { $Source = Split-Path -Parent $PSScriptRoot }
$Source = Resolve-SourcePath $Source
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
# Four things can be running the old code, and each is found by evidence:
#   1. the TUI supervisor, by its published state: a live `supervisor.pid` (or the
#      `supervisor_pid` in status.json) plus a heartbeat younger than 10s. It is asked to shut
#      down over its control path, not killed, so it takes its server down in order. Its command
#      line is deliberately not evidence - a wrapper, a relaunch or `python -m` hides it.
#   2. the legacy run.cmd launcher loop (cmd.exe), by command line.
#   3. the node holding the port, only if its command line runs *our* server.mjs.
#   4. the same node found by command line alone, for the rig where the listener's owning pid
#      is reported as 0 and the server's own command line says `server.mjs`, not its full path.
# The supervisor may have started the server through run.cmd, so 2 to 4 run
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

function Get-NodeProcess([string]$AppDir, [int]$Port, $Table) {
    # The port's owning pid is not evidence on this rig: netstat -ano and Get-NetTCPConnection
    # both report the 8972 listener as pid 0, so Test-IsOurs declines. The server is started
    # with a bare relative 'server.mjs', so its command line does not name the script either -
    # it names the install dir in --state/--log-dir instead. That, or this port, is the rule:
    # a process is stopped only when its own command line claims this install or this port.
    $dir = [regex]::Escape($AppDir.TrimEnd('\')) + '(?=[\\"\s]|$)'
    $portArg = '--port(=|\s+)"?' + $Port + '\b'
    return @(foreach ($p in $Table) {
        if ($p.Name -ne 'node.exe') { continue }
        if (-not $p.CommandLine) { continue }
        if ([int]$p.ProcessId -eq $PID) { continue }
        if ($p.CommandLine -match $dir -or $p.CommandLine -match $portArg) { $p }
    })
}

function Read-RuntimePid([string]$Path) {
    # Tolerant read of a runtime file. This used to be `Get-Content` on supervisor.lock, which
    # fails with "another process has locked a portion of the file" - that is why the old
    # fallback never once produced a pid. Ask for a shareable read instead: a file the OS or an
    # indexer holds must still yield the bytes it already contains.
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    } catch {
        return 0
    }
    try {
        $reader = New-Object System.IO.StreamReader($fs)
        $text = $reader.ReadToEnd()
        $reader.Dispose()
    } catch {
        return 0
    } finally {
        $fs.Dispose()
    }
    $n = 0
    if ([int]::TryParse(($text -replace '[^0-9]', ''), [ref]$n) -and $n -gt 0) { return $n }
    return 0
}

function Get-SupervisorState([string]$AppDir, $Table) {
    # Ask the live process, not its command line. Precedence, and which signal wins:
    #   1. a pid that names a live process: supervisor.pid, then status.json's supervisor_pid
    #      (the same value, published twice). A live pid beats a stale heartbeat - a wedged
    #      supervisor is still a process that holds the lock and must be stopped, so calling it
    #      "not running" would be a lie.
    #   2. otherwise a heartbeat younger than 10s: something wrote it, so a supervisor is up
    #      even when no pid file survived; then hunt the pid by command line, best effort.
    #   3. otherwise not running. A dead pid beats a fresh heartbeat: nothing can write a
    #      heartbeat after its writer is gone.
    # A command line that does not name this app dir is *not* evidence of absence - that is the
    # bug this replaces. A wrapper, a relaunch, `python -m`, a renamed exe and a venv path all
    # miss it, and an install once printed "no TUI supervisor running" over a live supervisor.
    $runtime = Join-Path $env:LOCALAPPDATA 'ShockBox\runtime'
    $live = @{}
    # pid -> command line. A pid alone is not proof: pids are reused, and a stale
    # supervisor.pid once named a pid that had belonged to another program for days.
    foreach ($p in $Table) { $live[[int]$p.ProcessId] = [string]$p.CommandLine }

    $candidates = @()
    $fromPid = Read-RuntimePid (Join-Path $runtime 'supervisor.pid')
    if ($fromPid -gt 0) { $candidates += $fromPid }
    $statusPath = Join-Path $runtime 'status.json'
    if (Test-Path -LiteralPath $statusPath) {
        # ConvertFrom-Json + StrictMode: a missing property is a trap, so check it exists.
        try { $st = Get-Content -LiteralPath $statusPath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $st = $null }
        if ($st -and $st.PSObject.Properties['supervisor_pid']) {
            $sp = 0
            if ([int]::TryParse([string]$st.supervisor_pid, [ref]$sp) -and $sp -gt 0) { $candidates += $sp }
        }
    }
    $age = $null
    $hb = Join-Path $runtime 'heartbeat'
    if (Test-Path -LiteralPath $hb) {
        try { $age = [math]::Round(((Get-Date) - (Get-Item -LiteralPath $hb).LastWriteTime).TotalSeconds, 1) } catch { $age = $null }
    }
    # Reap a supervisor.pid that does not name a live supervisor. It is the one runtime file
    # that outlives its writer (SIGKILL, reboot, the other OS's tree), and left in place it makes
    # the next reader believe in a supervisor that does not exist.
    if ($fromPid -gt 0 -and -not ($live.ContainsKey($fromPid) -and (-not $live[$fromPid] -or $live[$fromPid] -match 'shockbox_tui'))) {
        Remove-Item -LiteralPath (Join-Path $runtime 'supervisor.pid') -Force -ErrorAction SilentlyContinue
    }
    foreach ($c in ($candidates | Select-Object -Unique)) {
        if (-not $live.ContainsKey([int]$c)) { continue }
        # An unreadable command line is "unknown", not "not ours": a permissions hiccup must not
        # turn a live supervisor into a missing one. A readable one that is not shockbox_tui is a
        # reused pid, and believing it would be the same lie pointing the other way.
        if ($live[[int]$c] -and $live[[int]$c] -notmatch 'shockbox_tui') { continue }
        return @{ Alive = $true; Pid = [int]$c; Age = $age; Why = "published pid $c is alive and is a shockbox_tui process" }
    }
    if ($null -ne $age -and $age -le 10) {
        # No pid on file but something is breathing. Find it: the supervisor, not the TUI that
        # watches it (both import shockbox_tui). A Windows venv launcher runs python twice
        # (stub -> real interpreter) and both match; the inner one holds the lock.
        $hits = @(foreach ($p in $Table) {
            if ($p.ProcessId -eq $PID -or -not $p.CommandLine) { continue }
            if ($p.CommandLine -match 'shockbox_tui') { $p }
        })
        $strict = @($hits | Where-Object { $_.CommandLine -match 'shockbox_tui\.supervisor' })
        if ($strict.Count -gt 0) { $hits = $strict }
        $ids = @($hits | ForEach-Object { [int]$_.ProcessId })
        $inner = @($hits | Where-Object { $ids -contains [int]$_.ParentProcessId })
        $found = 0
        if ($inner.Count -gt 0) { $found = [int]$inner[0].ProcessId }
        elseif ($hits.Count -gt 0) { $found = [int]$hits[0].ProcessId }
        return @{ Alive = $true; Pid = $found; Age = $age; Why = 'heartbeat is fresh, pid not published' }
    }
    return @{ Alive = $false; Pid = 0; Age = $age; Why = 'no live pid and the heartbeat is stale or missing' }
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

# Everything above the ShouldProcess guard only reads: it works out what is running and prints
# the pids and command lines it would stop. That is what makes -WhatIf a real dry run, and it
# is why the survey is out here instead of inside the guard.
$table = Get-ProcessTable

# 1. the TUI supervisor: ask, then insist. The evidence is its published state (live pid,
#    fresh heartbeat); a command line is used only to reject a pid that was reused, never to
#    require one - see Get-SupervisorState.
$state = Get-SupervisorState $AppDir $table
$sup = @()
if ($state.Alive -and $state.Pid -gt 0) { $sup += $state.Pid }
if ($state.Alive) {
    if ($sup.Count -gt 0) {
        Note ("TUI supervisor running as pid " + ($sup -join ', ') + " (" + $state.Why + ", heartbeat $($state.Age)s old)")
    } else {
        Note ("TUI supervisor running but its pid is not published (" + $state.Why + ", heartbeat $($state.Age)s old)")
    }
} else {
    Note ("no TUI supervisor running (" + $state.Why + ", heartbeat $($state.Age)s old)")
}

# 2. the legacy launcher loop (cmd.exe) survives its parent, and its child
# node is the process holding the port. Kill the loop first, or node comes
# back. Lazily-evaluated because the target's cmd may run from a copied folder
# whose path differs only by case (it does: 'shockbox' vs 'ShockBox').
$loops = @($table | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine -match 'run\.cmd' -and $_.CommandLine -match [regex]::Escape($AppDir) })
foreach ($loop in $loops) { Note "launcher pid $($loop.ProcessId): $($loop.CommandLine)" }

# 3. the port's listener, under the evidence rule. On this rig both netstat -ano and
# Get-NetTCPConnection report the port's owner as pid 0, so this finds nothing and 4 does the
# work; it still catches a foreign process that does name itself.
$listeners = @(Get-ListenerPid $Port)
$oursOnPort = @()
foreach ($listener in $listeners) {
    if ($listener -le 0) { continue }
    if (Test-IsOurs $listener $AppDir) {
        $oursOnPort += $listener
        Note "server pid $listener listens on port $Port"
    } elseif ($listener -eq 4) {
        Write-Warning "port $Port is held by the HTTP.sys service (pid 4), not ShockBox - leaving it"
    } else {
        $line = ($table | Where-Object { $_.ProcessId -eq $listener }).CommandLine
        Write-Warning "port $Port is held by pid $listener which is not this install ($line) - leaving it; the next start will report EADDRINUSE"
    }
}
if ($listeners.Count -gt 0 -and @($listeners | Where-Object { $_ -gt 0 }).Count -eq 0) {
    Note "port $Port listener reports pid 0 (owner not published) - matching node.exe by command line"
}

# 4. node.exe by command line. The listener's pid is not evidence here, and the server is
# started with a bare relative 'server.mjs', so Test-IsOurs cannot see it either. A process is
# ours when its own command line names this install dir or this port. Nothing else is stopped.
$nodes = @(Get-NodeProcess $AppDir $Port $table)
foreach ($n in $nodes) { Note ("node.exe pid " + $n.ProcessId + ": " + $n.CommandLine) }
if ($nodes.Count -eq 0) { Note "no node.exe names $AppDir or --port $Port" }

if ($PSCmdlet.ShouldProcess($AppDir, 'stop the TUI supervisor, the run.cmd launcher loop and the node serving the port')) {
    $asked = $false
    if ($sup.Count -gt 0) {
        if (Send-SupervisorShutdown $AppDir $table) {
            $asked = $true
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
    }

    foreach ($loop in $loops) {
        Stop-Process -Id $loop.ProcessId -Force -ErrorAction SilentlyContinue
        Note "stopped launcher pid $($loop.ProcessId)"
        $stopped += "launcher $($loop.ProcessId)"
    }

    foreach ($listener in @($oursOnPort | Where-Object { $nodes.ProcessId -notcontains $_ })) {
        Stop-Process -Id $listener -Force -ErrorAction SilentlyContinue
        Note "stopped server pid $listener (port $Port)"
        $stopped += "server $listener"
    }

    if ($nodes.Count -gt 0) {
        # Politeness first: a supervisor that was not already asked above may still be the
        # parent, and its shutdown takes the server down in order rather than yanking it.
        if (-not $asked -and (Send-SupervisorShutdown $AppDir $table)) {
            Note 'asked the supervisor to shut down'
            Start-Sleep -Milliseconds 500
        }
        $ids = @($nodes | ForEach-Object { [int]$_.ProcessId })
        $left = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($left.Count -gt 0) {
            Stop-Process -Id $left -ErrorAction SilentlyContinue
            # Bounded wait: five seconds, a look every 150ms. A hung server must not keep the
            # tree open while it is rewritten, so survivors are forced at the end.
            $deadline = (Get-Date).AddSeconds(5)
            while ($left.Count -gt 0 -and (Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 150
                $left = @($left | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
            }
        }
        if ($left.Count -gt 0) {
            Stop-Process -Id $left -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        }
        foreach ($id in $ids) {
            if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
                Write-Warning "node.exe pid $id survived Stop-Process -Force"
            } else {
                $how = if ($left -contains $id) { ' (forced)' } else { '' }
                Note "stopped server pid $id$how"
                $stopped += "server $id"
            }
        }
    }

    # A pid can be both the published listener and a command-line match; report it once.
    $stopped = @($stopped | Select-Object -Unique)
    if ($stopped.Count -eq 0) { Note 'nothing was running' }
    Start-Sleep -Milliseconds 700
} else {
    Note 'nothing was stopped (WhatIf)'
    Note 'to do it by hand: send "shutdown" to the live supervisor, end the run.cmd loop, then stop the node whose command line names this install dir or this port'
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
# A \\wsl... source is the exception: Copy-Item, see Test-WslUncPath.
$excludedDirs = @('.git', 'state-dev', 'node_modules', 'backups', '.cocoindex_code', '.openchamber', '.opencode', '.cortexkit', 'captures', '.tui-venv', '.venv')
$excludedFiles = @('*.log', '*.log.1', 'config.json', 'config.local.json')

# One /XD and one /XF, each followed by its own list: repeated switches re-parse
# differently from run to run, a single switch with a list is stable. The source's
# .git and the target's state/logs are separate /XD lists, chained by name too.
$useCopyItem = Test-WslUncPath $Source
if (-not $useCopyItem) {
    $roboArgs = @(
        $Source, $Target,
        '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:2', '/NJH', '/NJS', '/NP', '/NDL', '/XJ',
        '/XF') + $excludedFiles
    $roboArgs += @('/XD') + ($excludedDirs | ForEach-Object { Join-Path $Source $_ }) +
                 @((Join-Path $Target 'state'), (Join-Path $Target 'logs'), (Join-Path $Target 'backups'))
}

if ($PSCmdlet.ShouldProcess($Target, 'copy the tree (excluding .git state-dev node_modules backups .tui-venv .venv)')) {
    Step 'copy'
    if ($useCopyItem) {
        # \\wsl... sources: Copy-Item. Same exclusions, by name, and the target's own state,
        # logs and backups are skipped too so a dev checkout's working state never lands on
        # the rig's live one.
        Copy-TreeFallback -From $Source -To $Target -SkipDirs ($excludedDirs + @('state', 'logs')) -SkipFiles $excludedFiles
        Note 'copied with Copy-Item (WSL share)'
    } else {
        & robocopy.exe @roboArgs | Out-Null
        $code = $LASTEXITCODE
        if ($code -ge 8) { throw "robocopy failed with exit code $code" }
        Note "robocopy exit $code"
    }
} else {
    Step 'copy (WhatIf)'
    if ($useCopyItem) {
        Note ("copy $Source -> $Target with Copy-Item (WSL share; skipping " + (($excludedDirs + @('state', 'logs')) -join ' ') + ")")
    } else {
        Note ("robocopy " + ($roboArgs -join ' '))
    }
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
        $lnk.WindowStyle = 1
        $lnk.Save()
        Note "created $LnkPath"
        Note "         -> $Launcher"
    } else {
        Note "`$s = New-Object -ComObject WScript.Shell; `$l = `$s.CreateShortcut('$LnkPath'); `$l.TargetPath='$Launcher'; `$l.WorkingDirectory='$Target'; `$l.IconLocation='$IconTarget'; `$l.WindowStyle=1; `$l.Save()"
    }
} else {
    Write-Warning "launcher not found: $Launcher - no shortcut created; re-run the installer from a checkout that has deploy\ShockBox-TUI.cmd"
}

Step 'done'
Note 'no auto-start at logon: start ShockBox from the desktop shortcut "ShockBox"'
Note "logs:   $Target\logs"
Note "state:  $Target\state"
Note 'no scheduled task is registered; the TUI supervisor owns the server process'
