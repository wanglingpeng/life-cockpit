@echo off
rem 生活驾驶舱 - 本机启动器（本文件必须以 ANSI/GBK 编码保存，勿存为 UTF-8）
cd /d %~dp0
title 生活驾驶舱

echo ==========================================
echo   生活驾驶舱 - 本机启动器
echo   关闭本窗口即停止服务；异常退出会自动重启
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

for /f "tokens=*" %%i in ('node -v') do set "NODE_VER=%%i"
node -e "process.exit(parseInt(process.versions.node.split('.')[0])>=16?0:1)"
if errorlevel 1 goto BAD_NODE
echo [OK] 环境自检通过：Node.js %NODE_VER%
echo.

if defined PORT ( set "PORT_NUM=%PORT%" ) else ( set "PORT_NUM=15808" )

netstat -ano 2>nul | findstr "LISTENING" | findstr ":%PORT_NUM% " >nul 2>nul
if errorlevel 1 goto START
echo [!] 端口 %PORT_NUM% 已有程序在监听：如果本服务已在运行，请不要再开第二个实例。
echo     服务端有实例锁保护，第二个实例会自动退出，不会破坏数据。
echo.

:START
echo [启动] 访问地址：http://127.0.0.1:%PORT_NUM%
echo        手机或其他电脑访问需以 HOST=0.0.0.0 启动，详见 README 快速开始。
echo.

:loop
echo [%date% %time%] 启动服务...
node server.js
set "EXITCODE=%errorlevel%"
echo.
if "%EXITCODE%"=="78" goto LOCKED
if "%EXITCODE%"=="75" goto STOPPED
echo [%date% %time%] 服务退出（代码 %EXITCODE%），3 秒后自动重启...
timeout /t 3 /nobreak >nul
goto loop

:NO_NODE
echo [X] 没有检测到 Node.js。
echo.
echo     请先安装 Node.js（免费，选 LTS 版本）：
echo     https://nodejs.org/zh-cn
echo     安装时一路默认即可，装完重新双击本文件。
echo.
pause
exit /b 1

:BAD_NODE
echo [X] Node.js 版本过低（当前 %NODE_VER%，需要 16 或以上）。
echo     请到 https://nodejs.org/zh-cn 重新安装 LTS 版本。
echo.
pause
exit /b 1

:STOPPED
echo [OK] Service stopped gracefully. All data flushed to disk.
echo      The auto-restart loop is now halted.
echo.
pause
exit /b 0
:LOCKED
echo [停机] 服务未启动：检测到另一实例正在运行（实例锁保护，防止数据互相覆盖）。
echo        本启动器不会自动重试。确认另一实例已关闭后，再重新运行本文件。
echo.
pause
exit /b 78
