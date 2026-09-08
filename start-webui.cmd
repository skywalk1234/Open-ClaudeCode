@echo off
rem OPC Web UI launcher - double-click to start. Stop with Ctrl+C.
rem Optional argument: start-webui.cmd [port]   (default 8787)
rem Automation flags: set NO_BROWSE=1 to skip opening the browser,
rem                    set NO_PAUSE=1 to exit without pausing (scripting).
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=8787"
if not "%~1"=="" set "PORT=%~1"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "webui\server.js" goto nosrv
if not exist "package\cli.js" echo [warn] package\cli.js not found - sending messages will fail.

echo.
echo  OPC Web UI   http://127.0.0.1:%PORT%
echo  Press Ctrl+C to stop. On first use, save your own DeepSeek API key at the top of the page.
echo.

if not defined NO_BROWSE (
  start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:%PORT%"
)

node webui\server.js --port %PORT%
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto done
echo.
echo  Server exited with code %RC%. If the port is busy, retry: start-webui.cmd 8788
goto done

:nonode
echo.
echo  [error] Node.js not found. Install Node.js 18 or later and add it to PATH.
echo          https://nodejs.org
goto done

:nosrv
echo.
echo  [error] webui\server.js not found next to this script.
echo          Put this file at the repo root (same level as the webui\ and package\ folders).

:done
if not defined NO_PAUSE pause
endlocal
