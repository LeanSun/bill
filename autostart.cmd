@echo off
chcp 65001 >nul
title 轻账 · 开机自启设置
cd /d "%~dp0"

set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\轻账.lnk"

if /i "%~1"=="uninstall" goto uninstall

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath='%~dp0start-ledger.cmd';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.WindowStyle=7;" ^
  "$s.Description='轻账 · 收支看板本地服务';" ^
  "$s.Save();" ^
  "if (Test-Path '%LNK%') { Write-Host '[ok] 已加入开机启动' } else { Write-Host '[x] 创建失败' }"

echo.
echo   下次开机自动在后台最小化启动，站点仍是 http://127.0.0.1:8787
echo   撤销：双击本文件并加上参数 uninstall，或直接删掉
echo   %LNK%
echo.
pause
exit /b 0

:uninstall
if exist "%LNK%" (
  del "%LNK%"
  echo   [ok] 已取消开机自启
) else (
  echo   [i] 本来就没设置过
)
echo.
pause
