Option Explicit

Dim fso, shell, projectRoot, nodePath, nodeCommand, command, localAppData, logDir, logFile
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = projectRoot
localAppData = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
If localAppData = "%LOCALAPPDATA%" Or localAppData = "" Then localAppData = shell.ExpandEnvironmentStrings("%TEMP%")
logDir = localAppData & "\Zaichang\source-dev"
If Not fso.FolderExists(localAppData & "\Zaichang") Then fso.CreateFolder(localAppData & "\Zaichang")
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
logFile = logDir & "\dev-start.log"

nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If fso.FileExists(nodePath) Then
  nodeCommand = Chr(34) & nodePath & Chr(34)
Else
  nodeCommand = "node"
End If

' Keep the console hidden while retaining a diagnostic log beside the isolated profile.
command = shell.ExpandEnvironmentStrings("%ComSpec%") & " /d /c " & Chr(34) & nodeCommand & " " & Chr(34) & projectRoot & "\scripts\dev.mjs" & Chr(34) & " >> " & Chr(34) & logFile & Chr(34) & " 2>&1" & Chr(34)
shell.Run command, 0, False
