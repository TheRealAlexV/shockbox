#Requires -Version 5.1
<#
.SYNOPSIS
  Stop ShockBox and remove what the installer created: the desktop shortcut, the
  TUI virtualenv, and the "\ShockBox-Server" task if an old install left it.

.DESCRIPTION
  Stops the TUI supervisor (and, through it or after it, the server on the port)
  using the same evidence rules as install.ps1: a live pid from supervisor.pid or
  status.json, else a heartbeat younger than 10s. Its command line is never
  evidence of absence. The port's listener is stopped only if its command line
  runs *this* install's server.mjs. It never kills an unrelated process.

  Every other task on the host - ErrorPopups-Server, LedWallAgent, anything else -
  is left alone. The installed folder is kept: state, logs, the copied tree and
  the server code stay where they are, so a re-install is a copy, not a rebuild.
  Nothing is deleted outside the folder except the desktop shortcut.

.PARAMETER Target
  Install directory. Default C:\OBS\ShockBox.

.PARAMETER WhatIf
  Print what would happen without stopping anything or calling Unregister-ScheduledTask.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\uninstall.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$Target = 'C:\OBS\ShockBox',
    [string]$TaskName = 'ShockBox-Server',
    [int]$Port = 8972
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Step([string]$Message) { Write-Host "==> $Message" }
function Note([string]$Message) { Write-Host "    $Message" }

Step 'uninstall ShockBox'
Note "target  $Target"

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

function Read-RuntimePid([string]$Path) {
    # Same rule as install.ps1: never Get-Content on a file another process may hold. The lock is
    # 0 bytes and cannot carry a pid either way - a supervisor publishes it in supervisor.pid.
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

function Get-SupervisorState {
    # Ask the live process, not its command line - the rule install.ps1 uses (see
    # Get-SupervisorState there for the full rationale):
    #   1. a live pid (supervisor.pid, then status.json's supervisor_pid) is the supervisor,
    #      even with a stale heartbeat: a wedged process still holds the lock and must be stopped;
    #   2. otherwise a heartbeat younger than 10s means one is up and did not publish a pid;
    #   3. otherwise nothing. A dead pid beats a fresh heartbeat.
    # A command line that does not name this app dir is NOT evidence of absence. The old test
    # here matched `shockbox_tui` to the app dir, so a supervisor launched with a relative path,
    # a wrapper, or a venv-shimmed python was invisible and the uninstall said "no TUI supervisor
    # running" over a live one.
    $runtime = Join-Path $env:LOCALAPPDATA 'ShockBox\runtime'
    $live = @{}
    foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) { $live[[int]$p.ProcessId] = $true }

    $candidates = @()
    $fromPid = Read-RuntimePid (Join-Path $runtime 'supervisor.pid')
    if ($fromPid -gt 0) { $candidates += $fromPid }
    $statusPath = Join-Path $runtime 'status.json'
    if (Test-Path -LiteralPath $statusPath) {
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
    foreach ($c in ($candidates | Select-Object -Unique)) {
        if ($live.ContainsKey([int]$c)) {
            return @{ Alive = $true; Pid = [int]$c; Age = $age; Why = "published pid $c is alive" }
        }
    }
    if ($age -ne $null -and $age -le 10) {
        return @{ Alive = $true; Pid = 0; Age = $age; Why = 'heartbeat is fresh, pid not published' }
    }
    return @{ Alive = $false; Pid = 0; Age = $age; Why = 'no live pid and the heartbeat is stale or missing' }
}

# ---- 1. stop the supervisor and the server ----------------------------------
Step 'stop'
if ($PSCmdlet.ShouldProcess($Target, 'stop the TUI supervisor and the server it runs')) {
    $state = Get-SupervisorState
    if ($state.Alive) {
        if ($state.Pid -gt 0) {
            Stop-Process -Id $state.Pid -Force -ErrorAction SilentlyContinue
            Note ("stopped TUI supervisor pid " + $state.Pid + " (" + $state.Why + ", heartbeat $($state.Age)s old)")
        } else {
            Write-Warning ("a TUI supervisor is running but published no pid (" + $state.Why + ", heartbeat $($state.Age)s old); stop it from the TUI or Task Manager")
        }
        Start-Sleep -Milliseconds 700
    } else {
        Note ("no TUI supervisor running (" + $state.Why + ", heartbeat $($state.Age)s old)")
    }

    $loops = @(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'run\.cmd' -and $_.CommandLine -match [regex]::Escape($Target) })
    foreach ($loop in $loops) {
        Stop-Process -Id $loop.ProcessId -Force -ErrorAction SilentlyContinue
        Note "stopped run.cmd launcher pid $($loop.ProcessId)"
    }

    $killPort = 0
    foreach ($listener in @(Get-ListenerPid $Port)) {
        if (Test-IsOurs $listener $Target) {
            Stop-Process -Id $listener -Force -ErrorAction SilentlyContinue
            Note "stopped server pid $listener (port $Port)"
            $killPort += 1
        } elseif ($listener -eq 4) {
            Write-Warning "port $Port is held by HTTP.sys (pid 4), not ShockBox - leaving it"
        } else {
            Write-Warning "port $Port is held by pid $listener which is not this install - leaving it"
        }
    }
    if ($state.Alive -or $loops.Count -gt 0 -or $killPort -gt 0) { Note 'stopped what was running' } else { Note 'nothing was running' }
} else {
    Note "stop the TUI supervisor (a live supervisor.pid or status.json supervisor_pid, or a heartbeat younger than 10s), the run.cmd launcher, and the node serving $Port if it runs $Target\server.mjs"
}

# ---- 2. the old scheduled task, if a previous install left one ---------------
Step "task \$TaskName"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($PSCmdlet.ShouldProcess("\$TaskName", 'end and unregister')) {
        schtasks.exe /End /TN $TaskName | Out-Null
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Note 'ended and unregistered'
    } else {
        Note "schtasks /End /TN $TaskName ; Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
    }
} else {
    Note 'no such task - nothing to do'
}

# ---- 3. the desktop shortcut -------------------------------------------------
Step 'shortcut'
$LnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ShockBox.lnk'
if (Test-Path -LiteralPath $LnkPath) {
    if ($PSCmdlet.ShouldProcess($LnkPath, 'remove the desktop shortcut')) {
        Remove-Item -LiteralPath $LnkPath -Force
        Note "removed $LnkPath"
    } else {
        Note "Remove-Item -LiteralPath $LnkPath -Force"
    }
} else {
    Note 'no desktop shortcut'
}

# ---- 4. the TUI virtualenv ---------------------------------------------------
Step 'TUI virtualenv'
$Venv = Join-Path $Target '.tui-venv'
if (Test-Path -LiteralPath $Venv) {
    if ($PSCmdlet.ShouldProcess($Venv, 'remove the TUI virtualenv')) {
        # -Recurse over a venv is long-ish but safe; failures are reported, not
        # fatal, because a stray file must not stop the uninstall halfway.
        try {
            Remove-Item -LiteralPath $Venv -Recurse -Force -ErrorAction Stop
            Note "removed $Venv"
        } catch {
            Write-Warning "could not fully remove $Venv : $($_.Exception.Message)"
        }
    } else {
        Note "Remove-Item -LiteralPath $Venv -Recurse -Force"
    }
} else {
    Note 'no virtualenv'
}

Step 'done'
Note 'kept: the installed folder, its state, its logs (uninstall never deletes them)'
Note 'kept: every other scheduled task on the host (ErrorPopups-Server, LedWallAgent, ...)'
Note 'the app is left stopped: start it again from the desktop shortcut (ShockBox)'
