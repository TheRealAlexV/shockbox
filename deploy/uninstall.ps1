#Requires -Version 5.1
<#
.SYNOPSIS
  Stop ShockBox and remove what the installer created: the desktop shortcut, the
  TUI virtualenv, and the "\ShockBox-Server" task if an old install left it.

.DESCRIPTION
  Stops the TUI supervisor through its own control channel - a `shutdown` command in
  `<ProgramData>\ShockBox\runtime\cmd.json`, the machine-wide directory the supervisor polls,
  so a stack owned by SYSTEM in session 0 is stopped too - then waits for its heartbeat to go
  stale. Only if that fails does it fall back to the process table, and then only to processes
  whose own command line proves they are this install. A process it cannot inspect is reported
  as such and never killed. If the supervisor is still running afterwards the uninstall fails
  (non-zero) before removing the virtualenv or the shortcut, rather than claiming success.

  The runtime directory is per machine, not per account: `%PROGRAMDATA%\ShockBox\runtime`.

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

function Get-ProcessOwnership([int]$ProcId, [string]$AppDir) {
    # 'ours' | 'foreign' | 'unknown'. An empty CommandLine is unknown, NOT "not ours": across
    # accounts Win32_Process hides it. Unknown still means "do not kill", but it must be
    # reported as unknown instead of being treated as somebody else's process.
    if ($ProcId -le 0) { return 'unknown' }
    try {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcId" -ErrorAction Stop
    } catch {
        return 'unknown'
    }
    if (-not $p) { return 'foreign' }
    if (-not $p.CommandLine) { return 'unknown' }
    if ($p.CommandLine -match 'server\.mjs' -and $p.CommandLine -match [regex]::Escape($AppDir)) { return 'ours' }
    return 'foreign'
}

function Get-ProcessLabel([int]$ProcId, $Table) {
    if ($ProcId -le 0) { return 'pid 0 (owner not published)' }
    $name = 'name unreadable'
    $row = @($Table | Where-Object { [int]$_.ProcessId -eq $ProcId })
    if ($row.Count -gt 0 -and $row[0].Name) { $name = [string]$row[0].Name }
    $owner = $null
    try {
        if ($row.Count -gt 0) {
            $o = Invoke-CimMethod -InputObject $row[0] -MethodName GetOwner -ErrorAction Stop
            if ($o -and $o.User) { $owner = "$($o.Domain)\$($o.User)" }
        }
    } catch {
        $owner = $null
    }
    if ($owner) { return "pid $ProcId ($name, $owner)" }
    return "pid $ProcId ($name, owner not readable)"
}

function Get-RuntimeDir {
    # Machine-wide, deliberately: a supervisor owned by another account (SYSTEM, session 0)
    # reads %PROGRAMDATA%\ShockBox\runtime, not the caller's %LOCALAPPDATA%. Create it if
    # missing; leave an existing ACL alone - the app owns the ACL.
    $base = $env:ProgramData
    if (-not $base) { $base = 'C:\ProgramData' }
    $runtime = Join-Path $base 'ShockBox\runtime'
    if (-not (Test-Path -LiteralPath $runtime)) {
        if ($PSCmdlet.ShouldProcess($runtime, 'create the machine-wide runtime directory')) {
            New-Item -ItemType Directory -Force -Path $runtime | Out-Null
        }
    }
    return $runtime
}

function Get-HeartbeatSeq([string]$Runtime) {
    $path = Join-Path $Runtime 'heartbeat'
    if (-not (Test-Path -LiteralPath $path)) { return -1 }
    try {
        $text = [System.IO.File]::ReadAllText($path)
    } catch {
        return -1
    }
    $n = 0
    if ([int]::TryParse((($text.Trim() -split '\s+')[0]), [ref]$n)) { return $n }
    return -1
}

function Get-HeartbeatAge([string]$Runtime) {
    $path = Join-Path $Runtime 'heartbeat'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return [math]::Round(((Get-Date) - (Get-Item -LiteralPath $path).LastWriteTime).TotalSeconds, 1)
    } catch {
        return $null
    }
}

function Request-SupervisorShutdown([string]$Runtime, [int]$SupervisorPid) {
    # The app's own control channel: supervisor.py polls <runtime>\cmd.json every tick and bumps
    # the heartbeat counter on the tick it executes a command. A file in the machine-wide runtime
    # dir works across accounts; the old Stop-Process could not touch a SYSTEM-owned supervisor.
    # Wait on evidence: ack = cmd.json gone or seq advanced; done = heartbeat stale (12s) or the
    # published pid exited.
    $age = Get-HeartbeatAge $Runtime
    if ($null -eq $age -or $age -gt 10) { return $false }
    $cmd = Join-Path $Runtime 'cmd.json'
    $seq = Get-HeartbeatSeq $Runtime
    try {
        $body = @{
            id     = [guid]::NewGuid().ToString('N')
            action = 'shutdown'
            at     = (Get-Date).ToString('o')
        } | ConvertTo-Json -Compress
        $tmp = "$cmd.$PID.tmp"
        [System.IO.File]::WriteAllText($tmp, $body)
        Move-Item -LiteralPath $tmp -Destination $cmd -Force
    } catch {
        Write-Warning "could not write the shutdown command to $cmd : $($_.Exception.Message)"
        return $false
    }
    $deadline = (Get-Date).AddSeconds(30)
    $acked = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        if (-not (Test-Path -LiteralPath $cmd)) { $acked = $true }
        if ((Get-HeartbeatSeq $Runtime) -gt $seq) { $acked = $true }
        if ($acked) {
            $after = Get-HeartbeatAge $Runtime
            $exited = $SupervisorPid -gt 0 -and -not (Get-Process -Id $SupervisorPid -ErrorAction SilentlyContinue)
            if ($null -eq $after -or $after -gt 12 -or $exited) { return $true }
        }
    }
    return $false
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
    $runtime = Get-RuntimeDir
    $live = @{}
    # pid -> command line, for the same reason as install.ps1: a pid that is alive is not
    # necessarily a supervisor, and this runtime file outlives the process that wrote it.
    foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) { $live[[int]$p.ProcessId] = [string]$p.CommandLine }

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
    # Reap a supervisor.pid that does not name a live supervisor (same rule as install.ps1):
    # it survives its writer and would otherwise be read as a supervisor that does not exist.
    if ($fromPid -gt 0 -and -not ($live.ContainsKey($fromPid) -and (-not $live[$fromPid] -or $live[$fromPid] -match 'shockbox_tui'))) {
        Remove-Item -LiteralPath (Join-Path $runtime 'supervisor.pid') -Force -ErrorAction SilentlyContinue
    }
    foreach ($c in ($candidates | Select-Object -Unique)) {
        if (-not $live.ContainsKey([int]$c)) { continue }
        # Unknown command line: believe the pid. Readable and not ours: a reused pid, skip it.
        if ($live[[int]$c] -and $live[[int]$c] -notmatch 'shockbox_tui') { continue }
        return @{ Alive = $true; Pid = [int]$c; Age = $age; Why = "published pid $c is alive and is a shockbox_tui process" }
    }
    if ($age -ne $null -and $age -le 10) {
        return @{ Alive = $true; Pid = 0; Age = $age; Why = 'heartbeat is fresh, pid not published' }
    }
    return @{ Alive = $false; Pid = 0; Age = $age; Why = 'no live pid and the heartbeat is stale or missing' }
}

# ---- 1. stop the supervisor and the server ----------------------------------
Step 'stop'
$runtime = Get-RuntimeDir
$table = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$state = Get-SupervisorState
if ($state.Alive) {
    if ($state.Pid -gt 0) {
        Note ("TUI supervisor running as pid " + $state.Pid + " (" + $state.Why + ", heartbeat $($state.Age)s old)")
    } else {
        Note ("TUI supervisor running but its pid is not published (" + $state.Why + ", heartbeat $($state.Age)s old)")
    }
} else {
    Note ("no TUI supervisor running (" + $state.Why + ", heartbeat $($state.Age)s old)")
}

$loops = @($table | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine -match 'run\.cmd' -and $_.CommandLine -match [regex]::Escape($Target) })
$listeners = @(Get-ListenerPid $Port)
$oursOnPort = @()
$foreignOnPort = @()
foreach ($listener in $listeners) {
    if ($listener -le 0) { continue }
    switch (Get-ProcessOwnership $listener $Target) {
        'ours' { $oursOnPort += $listener; Note "server pid $listener listens on port $Port" }
        'unknown' { Note "port $Port listener $(Get-ProcessLabel $listener $table) cannot be inspected - leaving it" }
        default {
            if ($listener -eq 4) {
                Write-Warning "port $Port is held by HTTP.sys (pid 4), not ShockBox - leaving it"
            } else {
                $foreignOnPort += $listener
            }
        }
    }
}

$asked = $false
if ($PSCmdlet.ShouldProcess($Target, 'stop the TUI supervisor and the server it runs')) {
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null

    # 1. the app first. Cross-account safe: a file in the machine-wide runtime dir, not a handle
    #    in this session. Stop-Process could never touch a supervisor owned by SYSTEM.
    if ($state.Alive) {
        if (Request-SupervisorShutdown $runtime $state.Pid) {
            $asked = $true
            Note 'the supervisor shut down on request'
        } else {
            Write-Warning "the supervisor did not shut down on request (heartbeat $((Get-HeartbeatAge $runtime))s old); falling back to the process table"
        }
    }

    # 2. fallback: only what our own command line proves is ours.
    if (-not $asked -and $state.Pid -gt 0) {
        $row = @($table | Where-Object { [int]$_.ProcessId -eq $state.Pid })
        if ($row.Count -gt 0 -and $row[0].CommandLine -match 'shockbox_tui') {
            Stop-Process -Id $state.Pid -Force -ErrorAction SilentlyContinue
            Note ("stopped TUI supervisor pid " + $state.Pid)
        } elseif (Get-Process -Id $state.Pid -ErrorAction SilentlyContinue) {
            Note "supervisor pid $($state.Pid) is alive but its command line cannot be read - leaving it"
        }
    }

    foreach ($loop in $loops) {
        Stop-Process -Id $loop.ProcessId -Force -ErrorAction SilentlyContinue
        Note "stopped run.cmd launcher pid $($loop.ProcessId)"
    }

    foreach ($listener in $oursOnPort) {
        Stop-Process -Id $listener -Force -ErrorAction SilentlyContinue
        Note "stopped server pid $listener (port $Port)"
    }
    Start-Sleep -Milliseconds 700
} else {
    Note "stop the TUI supervisor (write {\"action\":\"shutdown\"} to $runtime\cmd.json), the run.cmd launcher, and the node serving $Port if it runs $Target\server.mjs"
}

# ---- 1b. do not remove the venv under a stack that is still running ----------
# Removing .tui-venv and the shortcut while the supervisor lives leaves a stack that cannot be
# restarted cleanly, and exiting 0 over it is the same false success the installer had. A
# foreign listener on the port is not a reason to fail: this uninstall does not need the port.
if (-not $WhatIfPreference) {
    $stillSup = $state.Pid -gt 0 -and (Get-Process -Id $state.Pid -ErrorAction SilentlyContinue)
    $oursLeft = @($oursOnPort | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $unknownSup = $state.Pid -le 0 -and -not $asked -and ((Get-HeartbeatAge $runtime) -ne $null) -and ((Get-HeartbeatAge $runtime) -lt 10)
    if ($stillSup -or $oursLeft.Count -gt 0 -or $unknownSup) {
        $block = if ($state.Pid -gt 0) { $state.Pid } elseif ($oursLeft.Count -gt 0) { [int]$oursLeft[0] } else { 0 }
        $blockLabel = Get-ProcessLabel $block $table
        Write-Host ''
        Write-Host "the stack is still running: $blockLabel - it was not stopped" -ForegroundColor Red
        Write-Host 'UNINSTALL DID NOT COMPLETE: removing the virtualenv and the shortcut under a live supervisor leaves a stack that cannot be restarted cleanly. Nothing was removed.' -ForegroundColor Red
        if ($block -gt 0) {
            Write-Host "Run this from an elevated prompt, then re-run the uninstaller: taskkill /F /PID $block" -ForegroundColor Red
        } else {
            Write-Host "Run the uninstaller from an elevated prompt: Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$PSCommandPath'" -ForegroundColor Red
        }
        exit 1
    }
    if ($foreignOnPort.Count -gt 0) {
        Write-Warning "port $Port is held by pid $($foreignOnPort -join ', '), which is not this install - it is not touched; the uninstall does not need the port"
    }
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
