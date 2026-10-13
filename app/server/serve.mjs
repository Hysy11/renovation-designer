// 本地静态服务（方案 9.6 节）：不依赖任何第三方包，只监听本机，固定端口 5180。
// 浏览器的本地数据按“网址 + 端口”存放，所以端口绝不能换（需求第 10 条差异说明）。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5180;
const HOST = '127.0.0.1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'); // 打包产物目录

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
    // localhost 与 127.0.0.1 是两个不同的“网址”，统一跳到 127.0.0.1，保证数据只有一份
    if (req.headers.host?.startsWith('localhost')) {
      res.writeHead(301, { Location: `http://${HOST}:${PORT}${url.pathname}${url.search}` });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('只支持 GET 请求');
      return;
    }
    // 防目录穿越：拼出的路径必须仍在 dist 内
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    } catch { /* 文件不存在时落到下面的 404 */ }
    let body;
    try { body = await readFile(path); } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 找不到文件。请先运行 npm run build 生成 dist 目录。');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 服务出错：${e instanceof Error ? e.message : String(e)}`);
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('5180 端口已被占用：如果程序已在运行，直接打开 http://127.0.0.1:5180；否则请关闭占用该端口的程序。');
  } else {
    console.error('启动失败：', e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`装修设计器已启动：请在浏览器打开 http://${HOST}:${PORT}`);
  console.log('关闭此窗口（或按 Ctrl+C）即停止服务。');
});
