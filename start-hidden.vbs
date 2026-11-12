' ============================================================
'  Life Cockpit - silent background launcher
'  Double-click to start the service with no console window.
'  It first checks port 15808; if the service is already
'  running it exits immediately instead of starting a
'  second instance (avoids EADDRINUSE).
'  To stop the service: run stop-service.bat
' ============================================================
Option Explicit
Dim fso, ws, baseDir, tmp, f, txt
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws  = CreateObject("WScript.Shell")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)

' ---- bail out if port 15808 is already listening ----
tmp = ws.ExpandEnvironmentStrings("%TEMP%") & "\life-cockpit-port.txt"
ws.Run "cmd /c netstat -ano | findstr :15808 | findstr LISTENING > """ & tmp & """", 0, True
If fso.FileExists(tmp) Then
  Set f = fso.OpenTextFile(tmp, 1)
  txt = f.ReadAll
  f.Close
  fso.DeleteFile tmp, True
  If Len(Trim(txt)) > 0 Then WScript.Quit
End If

' ---- launch hidden, detached from any parent shell ----
ws.Run "cmd /c cd /d """ & baseDir & """ && node server.js", 0, False
