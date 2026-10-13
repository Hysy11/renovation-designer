#!/bin/bash
# macOS 启动脚本：需要电脑已安装 Node.js 18 或更高版本（https://nodejs.org）。
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先到 https://nodejs.org 安装 18 或更高版本，再双击本文件。"
  read -r -p "按回车键关闭…" _
  exit 1
fi
echo "正在启动装修设计器…（关闭此窗口或按 Ctrl+C 即停止服务）"
node serve.mjs &
PID=$!
sleep 1
open "http://127.0.0.1:5180" 2>/dev/null
wait $PID
