@echo off
cd /d "%~dp0"
if exist "..\node_modules\electron\dist\electron.exe" (
  start "" "..\node_modules\electron\dist\electron.exe" .
) else (
  echo Please use the packaged RPE-Collaboration-Server.exe or install the editor development dependencies.
  pause
)
