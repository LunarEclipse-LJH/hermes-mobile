@echo off
rem Print + copy the current phone URL. Run this after a reboot / wifi reconnect:
rem the campus IPv6 prefix moves, and the APK's saved address goes stale.
setlocal
pushd "%~dp0"
if exist "%~dp0refresh_addrs.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0refresh_addrs.ps1"
powershell -NoProfile -Command "$j = Get-Content -Raw (Join-Path '%~dp0' 'addrs.json') | ConvertFrom-Json; $u = $j.urls | Where-Object { $_ -like 'http://[*' } | Select-Object -First 1; if ($u) { $u | Set-Clipboard; Write-Host ('  copied: ' + $u) } else { Write-Host '  no global IPv6 to copy' }"
echo   (paste it into the app: long-press BACK -> URL dialog)
echo.
pause
popd
