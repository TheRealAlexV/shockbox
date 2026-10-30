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
    Note "health: http://127.0.0.1:$Port/health  (give it a few seconds)"
    Note "logs:   $Target\logs"
} else {
    Note "schtasks /Run /TN $TaskName"
}

Step 'done'
