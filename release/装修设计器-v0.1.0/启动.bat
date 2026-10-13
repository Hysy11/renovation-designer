@echo off
rem Windows 启动脚本：需要电脑已安装 Node.js 18 或更高版本（https://nodejs.org）。
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先到 https://nodejs.org 安装 18 或更高版本，再双击本文件。
  pause
  exit /b 1
)
echo 正在启动装修设计器…（关闭此窗口或按 Ctrl+C 即停止服务）
start "" /b node serve.mjs
timeout /t 1 >nul
start "" "http://127.0.0.1:5180"
pause
