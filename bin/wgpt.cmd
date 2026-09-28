@echo off
setlocal
set "RESOURCES=%~dp0.."
set "ARCHIVE=%RESOURCES%\app.asar"

if not exist "%ARCHIVE%" (
  if not defined WGPT_NODE_EXECUTABLE set "WGPT_NODE_EXECUTABLE=node"
  if not defined WGPT_CLI_ENTRY set "WGPT_CLI_ENTRY=%RESOURCES%\out\cli\index.js"
  if not defined WGPT_DAEMON_ENTRY set "WGPT_DAEMON_ENTRY=%RESOURCES%\out\daemon\index.js"
  "%WGPT_NODE_EXECUTABLE%" "%WGPT_CLI_ENTRY%" %*
  exit /b %ERRORLEVEL%
)

if not defined WGPT_APP_EXECUTABLE set "WGPT_APP_EXECUTABLE=%RESOURCES%\..\Web GPT Agent.exe"
if not exist "%WGPT_APP_EXECUTABLE%" (
  echo wgpt: found "%ARCHIVE%" but no app executable at "%WGPT_APP_EXECUTABLE%" 1>&2
  exit /b 2
)
if not defined WGPT_CLI_ENTRY set "WGPT_CLI_ENTRY=%ARCHIVE%\out\cli\index.js"
if not defined WGPT_DAEMON_ENTRY set "WGPT_DAEMON_ENTRY=%RESOURCES%\app.asar.unpacked\out\daemon\index.js"
if not defined WGPT_NODE_EXECUTABLE (
  for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined WGPT_NODE_EXECUTABLE set "WGPT_NODE_EXECUTABLE=%%N"
)
set "ELECTRON_RUN_AS_NODE=1"
"%WGPT_APP_EXECUTABLE%" "%WGPT_CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
