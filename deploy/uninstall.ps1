#Requires -Version 5.1
<#
.SYNOPSIS
  Stop ShockBox and remove what the installer created: the desktop shortcut, the
  TUI virtualenv, and the "\ShockBox-Server" task if an old install left it.

.DESCRIPTION
  Stops the TUI supervisor (and, through it or after it, the server on the port)
  using the same evidence rules as install.ps1: the supervisor is found by its
  command line or its lock file, and the port's listener only if its command
  line runs *this* install's server.mjs. It never kills an unrelated process.

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

function Get-SupervisorPid([string]$AppDir) {
    $table = try { @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch { @() }
    $found = @()
    foreach ($p in $table) {
        if ($p.ProcessId -eq $PID) { continue }
        if (-not $p.CommandLine) { continue }
        if (($p.CommandLine -match 'shockbox_tui' -and $p.CommandLine -match [regex]::Escape($AppDir)) -or ($p.CommandLine -match 'supervisor\.lock')) {
            $found += $p.ProcessId
        }
    }
    $lock = Join-Path $env:LOCALAPPDATA 'ShockBox\runtime\supervisor.lock'
    if (Test-Path -LiteralPath $lock) {
        $raw = [string](Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue)
        foreach ($m in [regex]::Matches($raw, '\d+')) {
            $candidate = 0
            if ([int]::TryParse($m.Value, [ref]$candidate) -and ($table | Where-Object { $_.ProcessId -eq $candidate })) { $found += $candidate }
        }
    }
    return @($found | Select-Object -Unique)
}

# ---- 1. stop the supervisor and the server ----------------------------------
Step 'stop'
if ($PSCmdlet.ShouldProcess($Target, 'stop the TUI supervisor and the server it runs')) {
    $sup = @(Get-SupervisorPid $Target)
    if ($sup.Count -gt 0) {
        foreach ($s in $sup) {
            # The supervisor stops its own server. A force kill is the fallback:
            # the server's listener is handled below either way.
            Stop-Process -Id $s -Force -ErrorAction SilentlyContinue
            Note "stopped TUI supervisor pid $s"
        }
        Start-Sleep -Milliseconds 700
    } else {
        Note 'no TUI supervisor running'
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
    if ($sup.Count -eq 0 -and $loops.Count -eq 0 -and $killPort -eq 0) { Note 'nothing was running' }
} else {
    Note "stop the TUI supervisor (shockbox_tui, or the supervisor.lock holder), the run.cmd launcher, and the node serving $Port if it runs $Target\server.mjs"
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
