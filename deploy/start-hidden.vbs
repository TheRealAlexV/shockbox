' ShockBox Server - start the launcher with no console window.
' Registered as the "\ShockBox-Server" scheduled task at logon (see install.ps1), the same
' shape as the error-popups task that ran on this host before it.
'
' The window this hides is only the one wscript starts on behalf of cmd.exe. cmd keeps running
' (hidden) for as long as run.cmd runs it, so the restart loop on the other side lives inside it.
Option Explicit

Dim shell, project, launcher
project = "C:\OBS\ShockBox"
launcher = project & "\deploy\run.cmd"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = project

' 0 = hidden window, False = do not wait for it to exit
shell.Run """" & launcher & """", 0, False
