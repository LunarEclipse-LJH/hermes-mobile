' Hermes Mobile - autostart the dashboard at logon (window hidden).
' Idempotent: exits silently if 9119 is already listening.
' Portable: derives its own directory, so this repo can live anywhere.
Option Explicit

Dim sh, fso, rc, base
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)

' Already running? (started manually, or a previous logon)
rc = sh.Run("cmd /c netstat -an | find ""[::]:9119"" | find ""LISTENING"" >nul 2>&1", 0, True)
If rc = 0 Then WScript.Quit 0

sh.CurrentDirectory = base
sh.Run "cmd /c """ & base & "\start.cmd"" >> """ & base & "\dashboard.log"" 2>&1", 0, False
