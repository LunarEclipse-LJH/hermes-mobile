@echo off
setlocal
pushd "%~dp0"
set "HERMES_WEB_DIST=%CD%"
set "HERMES_EXE=%LOCALAPPDATA%\hermes\bin\hermes.cmd"
if not exist "%HERMES_EXE%" set "HERMES_EXE=hermes"

rem --- python: needed for the login password, the session secret and the bridge
set "PY="
for /d %%D in ("%LOCALAPPDATA%\hermes\tools\python-*") do if exist "%%~fD\python.exe" set "PY=%%~fD\python.exe"
if not defined PY set "PY=python"

rem --- credentials live OUTSIDE this repo, are generated once, and are never
rem printed: a password sitting in a tracked file (or on screen) is leaked.
set "KEYDIR=%LOCALAPPDATA%\hermes\keys"
if not exist "%KEYDIR%" mkdir "%KEYDIR%"
if not exist "%KEYDIR%\dashboard.pass" "%PY%" -c "import secrets,pathlib;pathlib.Path(r'%KEYDIR%\dashboard.pass').write_text(secrets.token_urlsafe(16),encoding='utf-8')"
if not exist "%KEYDIR%\basic_auth.secret" "%PY%" -c "import secrets,pathlib;pathlib.Path(r'%KEYDIR%\basic_auth.secret').write_text(secrets.token_hex(32),encoding='utf-8')"
set "HERMES_DASHBOARD_BASIC_AUTH_USERNAME=hermes"
set /p HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=<"%KEYDIR%\dashboard.pass"
set /p HERMES_DASHBOARD_BASIC_AUTH_SECRET=<"%KEYDIR%\basic_auth.secret"
if not defined HERMES_DASHBOARD_BASIC_AUTH_PASSWORD (
  echo   [fatal] cannot read "%KEYDIR%\dashboard.pass"
  goto :done
)

rem --- images are no longer hard-linked into assets\img ----------------------
rem This step used to hard-link cached images to assets\img\<name>, and the page
rem fetched /assets/img/<name>. Two problems: (1) dashboard_auth's bypass list
rem includes /assets/, and 9119 is reachable from the public campus IPv6 -- any
rem screenshot could be enumerated and downloaded without logging in; (2) links
rem were only rebuilt at startup, so a fresh image needed a restart to show up.
rem The page now uses /api/fs/download?path=<abs path> (cookie required) and
rem assets\img is retired. Keep this note so nobody adds the step back.
echo.
echo   Hermes mobile gateway
echo   ---------------------
echo   Web  : http://localhost:9119/
rem The campus IPv6 prefix rotates (reboot / wifi reconnect) and the address
rem expires every few hours: never hardcode it. This writes addrs.json (served
rem to the page) and prints every current global address.
if exist "%~dp0refresh_addrs.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0refresh_addrs.ps1"
echo   User : %HERMES_DASHBOARD_BASIC_AUTH_USERNAME%
echo   Pass : in %KEYDIR%\dashboard.pass  (not printed)
echo   Stop : hermes dashboard --stop
echo.

rem --- IPv4 sidecar -----------------------------------------------------------
rem Windows keeps IPV6_V6ONLY=1, so "--host ::" listens on IPv6 only: no IPv4
rem address answers at all (127.0.0.1 included). A phone on the laptop hotspot
rem only has IPv4, so it could never connect. ipv4_bridge.py binds 0.0.0.0 and
rem relays to [::1]; bridge_supervisor.py restarts it and logs why it died.
if exist "%~dp0bridge_supervisor.py" (
  start "hermes-ipv4-bridge" /b "%PY%" "%~dp0bridge_supervisor.py" 9119
) else (
  echo   [warn] bridge_supervisor.py absent - IPv4 clients ^(hotspot^) will fail
)
call "%HERMES_EXE%" dashboard --host "::" --port 9119 --skip-build --no-open
:done
popd
