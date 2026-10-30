#Requires -Version 5.1
<#
.SYNOPSIS
  Install (or upgrade) ShockBox on the OBS host as C:\OBS\ShockBox, with the
  "\ShockBox-Server" scheduled task that starts it at logon.

.DESCRIPTION
  Idempotent: run it as often as you like. It copies the tree over the target
  (never deleting state or logs), rewrites the task from deploy\ShockBox-Server.xml,
  enables it, and starts it once.

  It does not touch any other task, any other folder, and no running process it
  did not start itself. The old ErrorPopups-Server and LedWallAgent tasks are
  *not* removed here - retuning them is a separate, deliberate step (see
  deploy\README.md, "Retiring the old tasks").

.PARAMETER Target
  Install directory. Default C:\OBS\ShockBox.

.PARAMETER Source
  Repo checkout to copy from. Default: the parent of this script's folder.

.PARAMETER WhatIf
  Print every write, copy and task command without doing any of them. The one
  read-only action it still takes is checking that node.exe exists.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1 -WhatIf

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
    [string]$Target = 'C:\OBS\ShockBox',
    [string]$Source,
    [string]$TaskName = 'ShockBox-Server',
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
    [string]$RunAs = "$env:COMPUTERNAME\$env:USERNAME",
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
$TaskXml = Join-Path $PSScriptRoot 'ShockBox-Server.xml'
if (-not (Test-Path -LiteralPath $TaskXml)) { throw "Missing $TaskXml" }

Step "ShockBox install"
Note "source  $Source"
Note "target  $Target"
Note "task    \$TaskName"
Note "node    $NodeExe"
Note "run as  $RunAs"

if (-not (Test-Path -LiteralPath $NodeExe)) {
    # Not fatal: run.cmd falls back to `node` on PATH. Say so rather than fail install.
    Write-Warning "node.exe not found at $NodeExe - the launcher will fall back to 'node' on PATH"
}

# ---- 0. stop what this install is about to replace ---------------------------
# A copy over a live tree does not affect the running node (it already read its
# files), so the new code only takes effect after a restart. Restarting is this
# script's job, and it must happen here, before the copy: `schtasks /Run` on an
# already-running task starts nothing, and stopping the task while its launcher
# loop is still alive only respawns the old code. Stop the launcher, stop the
# node serving our port, copy, then start (step 4).
#
# Both stops are scoped by evidence, never by name alone: the port's listener is
# stopped only if its command line runs *our* server.mjs, and the launcher kill
# skips any process that is this install or any other install's supervisor.
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

Step 'stop'
$stopped = @()
if ($PSCmdlet.ShouldProcess("\$TaskName", 'stop')) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        schtasks.exe /End /TN $TaskName | Out-Null
        Note 'task ended'
        $stopped += 'task'
    } else {
        Note 'no task to stop'
    }

    # The launcher loop (cmd.exe) survives the task ending, and its child node is
    # the process holding the port. Kill the loop first, or node comes straight back.
    $loops = Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'run\.cmd' -and $_.CommandLine -match [regex]::Escape($AppDir) }
    # Lazily-evaluated because the target's cmd may run from a copied folder whose
    # path differs only by case (it does: 'shockbox' vs 'ShockBox').
    foreach ($loop in @($loops)) {
        Stop-Process -Id $loop.ProcessId -Force -ErrorAction SilentlyContinue
        Note "stopped launcher pid $($loop.ProcessId)"
        $stopped += "launcher $($loop.ProcessId)"
    }

    foreach ($listener in Get-ListenerPid $Port) {
        if (Test-IsOurs $listener $AppDir) {
            Stop-Process -Id $listener -Force -ErrorAction SilentlyContinue
            Note "stopped server pid $listener (port $Port)"
            $stopped += "server $listener"
        } elseif ($listener -eq 4) {
            Write-Warning "port $Port is held by the HTTP.sys service (pid 4), not ShockBox - leaving it"
        } else {
            $line = (Get-CimInstance Win32_Process -Filter "ProcessId = $listener" -ErrorAction SilentlyContinue).CommandLine
            Write-Warning "port $Port is held by pid $listener which is not this install ($line) - leaving it; the start below will report EADDRINUSE"
        }
    }

    if ($stopped.Count -eq 0) { Note 'nothing was running' }
    Start-Sleep -Milliseconds 700
} else {
    Note "schtasks /End /TN $TaskName ; stop the run.cmd launcher and the node serving $Port"
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
# live state and logs sitting in the target.
$excludedDirs = @('.git', 'state-dev', 'node_modules', 'backups', '.cocoindex_code', '.openchamber', '.opencode', '.cortexkit', 'captures')
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

if ($PSCmdlet.ShouldProcess($Target, 'copy the tree (robocopy /E, excluding .git state-dev node_modules backups)')) {
    Step 'copy'
    & robocopy.exe @roboArgs | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) { throw "robocopy failed with exit code $code" }
    Note "robocopy exit $code"
} else {
    Step "copy (WhatIf)"
    Note ("robocopy " + ($roboArgs -join ' '))
}

# ---- 3. the task -------------------------------------------------------------
# Registered from the XML so the settings are exactly ErrorPopups-Server's shape:
# S4U principal, logon trigger for the user, ExecutionTimeLimit PT0S,
# MultipleInstancesPolicy IgnoreNew, StartWhenAvailable, battery stops off.
$xmlText = Get-Content -LiteralPath $TaskXml -Raw
# The file is UTF-16; Register-ScheduledTask does not care, but the placeholders
# below keep one XML working on a host whose user name is not Alex.
$xmlText = $xmlText.Replace('ADV-DT01\Alex', $RunAs).Replace('C:\OBS\ShockBox', $Target)
if ($Port -ne 8972) {
    Write-Warning "The XML launches wscript, which runs run.cmd with port 8972 baked in; -Port $Port only changes this message."
}

Step "task \$TaskName"
if ($PSCmdlet.ShouldProcess("\$TaskName", 'register scheduled task (replace if present)')) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Note 'replacing the existing task'
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $TaskName -Xml $xmlText | Out-Null
    Note 'registered'
} else {
    Note 'Register-ScheduledTask -TaskName ShockBox-Server -Xml <deploy\ShockBox-Server.xml>'
}

if ($PSCmdlet.ShouldProcess("\$TaskName", 'enable')) {
    schtasks.exe /Change /TN $TaskName /Enable | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "schtasks /change failed with exit code $LASTEXITCODE" }
    Note 'enabled'
} else {
    Note "schtasks /Change /TN $TaskName /Enable"
}

# ---- 4. first run ------------------------------------------------------------
if ($PSCmdlet.ShouldProcess("\$TaskName", 'start now')) {
    schtasks.exe /Run /TN $TaskName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "schtasks /run failed with exit code $LASTEXITCODE" }
    Note 'started'
    # Wait for the new process to own the port, and say which pid it is: a start
    # that comes up on the *old* code (or not at all) must be visible here, not
    # discovered an hour later from a health endpoint that never changed.
    $newPid = $null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $cand = Get-ListenerPid $Port
        if ($cand.Count -gt 0) { $newPid = $cand[0]; break }
    }
    if ($null -eq $newPid) {
        Write-Warning "nothing is listening on $Port after 15s - check $Target\logs\launcher-*.log and shockbox-*.log"
    } else {
        Note "listening on $Port as pid $newPid"
        if ($stopped -contains "server $newPid") {
            Write-Warning "pid $newPid is a process this install just stopped - the old server came back"
        }
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
            Note ("health: ok, modules " + (($h.modules.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '))
            if ($h.pid -ne $newPid) { Write-Warning "health reports pid $($h.pid) but port $Port is held by $newPid" }
        } catch {
            Write-Warning "health did not answer: $($_.Exception.Message)"
        }
    }
    Note "logs:   $Target\logs"
    Note "logs:   $Target\logs"
} else {
    Note "schtasks /Run /TN $TaskName"
}

Step 'done'
