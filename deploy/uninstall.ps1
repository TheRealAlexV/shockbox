#Requires -Version 5.1
<#
.SYNOPSIS
  Stop and unregister the "\ShockBox-Server" scheduled task.

.DESCRIPTION
  Touches exactly one task. Every other task on the host - ErrorPopups-Server,
  LedWallAgent, anything else - is left alone, including one that happens to
  listen on the same port. The installed folder is kept: state, logs and the
  copied tree stay where they are so a re-install is a copy, not a rebuild.

.PARAMETER WhatIf
  Print what would happen without calling schtasks or Unregister-ScheduledTask.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\uninstall.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$TaskName = 'ShockBox-Server'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Step([string]$Message) { Write-Host "==> $Message" }

Step "uninstall \$TaskName"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Step "no such task - nothing to do"
    exit 0
}

# /End stops the running instance, which wscript handed to cmd; cmd's child node
# gets the console close and exits. It is scoped to this task by name.
if ($PSCmdlet.ShouldProcess("\$TaskName", 'stop')) {
    schtasks.exe /End /TN $TaskName | Out-Null
    Step 'stopped'
} else {
    Step "schtasks /End /TN $TaskName"
}

if ($PSCmdlet.ShouldProcess("\$TaskName", 'unregister')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Step 'unregistered'
} else {
    Step "Unregister-ScheduledTask -TaskName $TaskName"
}

Step 'done (the installed folder and its state/logs were left in place)'
