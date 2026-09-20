@echo off
setlocal
cd /d "%~dp0.."

set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto run

for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE (
  echo [在场] 找不到 Node.js，请先安装 Node.js 后再启动。
  pause
  exit /b 1
)

:run
echo [在场] 正在启动开发版，前端支持 Vite 实时更新……
"%NODE_EXE%" scripts\dev.mjs
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo [在场] 启动失败，退出码 %EXIT_CODE%。
  pause
)
exit /b %EXIT_CODE%
