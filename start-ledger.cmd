@echo off
chcp 65001 >nul
title 轻账 · 本地服务 (勿关此窗口)
cd /d "%~dp0"

rem ============================================================
rem  轻账 · 本机部署启动器
rem  双击即可。窗口保持打开 = 服务在跑；关窗口 = 服务停止。
rem  下面几行是全部可调项，改完保存再双击。
rem ============================================================

set "PORT=8787"
set "HOST=0.0.0.0"

rem 允许哪些页面跨域访问这份数据。
rem 用本机地址打开记的账不需要跨域；只有从 GitHub Pages 那个线上站
rem 连回本机时才需要，所以要留 https://leansun.github.io。
set "ALLOWED_ORIGINS=https://leansun.github.io,https://wbapp-h8twhqhcyxbvgz2dyfhkvj.app.workbuddy.host"

rem 数据放哪。留空 = server\data（口令、密钥、state.json、备份都在里面）
set "LEDGER_DATA="

rem 想自己定口令就填这里；留空 = 首次运行自动生成并写入 password.txt
set "LEDGER_PASSWORD="

rem ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [x] 没找到 node。装一个 Node 18 以上版本再来：https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not "%LEDGER_DATA%"=="" set "LEDGER_DATA=%LEDGER_DATA%"
if not "%LEDGER_PASSWORD%"=="" set "LEDGER_PASSWORD=%LEDGER_PASSWORD%"

echo.
echo   轻账 · 本地服务
echo   站点   http://127.0.0.1:%PORT%
echo   手机   http://本机局域网IP:%PORT%  ^(见下面启动日志或 ipconfig^)
echo   口令   %~dp0server\data\password.txt
echo.
echo   关闭此窗口即停止服务。
echo.

rem 服务起来后自动打开浏览器（2 秒后，避免抢在监听前）
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/'"

node server\server.js

echo.
echo   服务已停止。按任意键关闭。
pause >nul
