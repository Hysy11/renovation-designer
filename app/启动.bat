@echo off
rem Windows 启动脚本：进入本目录，启动本地服务并打开浏览器。需要电脑已安装 Node.js。
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动装修设计器…
start "" "http://127.0.0.1:5180"
node server\serve.mjs
pause
