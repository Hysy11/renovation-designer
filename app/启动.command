#!/bin/bash
# macOS 启动脚本：进入本目录，启动本地服务并打开浏览器。需要电脑已安装 Node.js。
cd "$(dirname "$0")"
echo "正在启动装修设计器…"
open "http://127.0.0.1:5180" 2>/dev/null
node server/serve.mjs
