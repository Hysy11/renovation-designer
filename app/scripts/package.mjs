// 程序包生成（方案 9.6）：npm run package → release/装修设计器-v版本号/
// 内含 web/（打包后的网页）、serve.mjs（改服务同级 web 目录）、启动.command、启动.bat、使用说明.txt。
// 用程序包只需要 Node.js 18+；开发和打包需要 Node 20.19+/22.12+（Vite 8 的要求，见 package.json engines）。
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const outDir = join(appDir, '..', 'release', `装修设计器-v${pkg.version}`);

// 1. 打包网页（走 package.json 的 build 脚本，保证与日常构建一致）
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['run', 'build'], { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });

// 2. 清掉旧输出，复制产物
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'web'), { recursive: true });
cpSync(join(appDir, 'dist'), join(outDir, 'web'), { recursive: true });

// 3. serve.mjs：把服务目录从开发布局（../dist）改成程序包布局（同级 web）
const serveSrc = readFileSync(join(appDir, 'server', 'serve.mjs'), 'utf8')
  .replace(`'..', 'dist'`, `'web'`)
  .replace(
    '404 找不到文件。请先运行 npm run build 生成 dist 目录。',
    '404 找不到文件：程序包不完整，请重新解压整个文件夹。',
  );
if (!serveSrc.includes(`join(dirname(fileURLToPath(import.meta.url)), 'web')`)) {
  throw new Error('server/serve.mjs 的目录写法变了，请同步更新 scripts/package.mjs');
}
if (!serveSrc.includes('程序包不完整')) {
  throw new Error('server/serve.mjs 的 404 文案变了，请同步更新 scripts/package.mjs');
}
writeFileSync(join(outDir, 'serve.mjs'), serveSrc);

// 4. 启动脚本：先起服务、再开浏览器，关闭窗口即停止
writeFileSync(
  join(outDir, '启动.command'),
  `#!/bin/bash
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
`,
);
chmodSync(join(outDir, '启动.command'), 0o755);

writeFileSync(
  join(outDir, '启动.bat'),
  ['@echo off',
    'rem Windows 启动脚本：需要电脑已安装 Node.js 18 或更高版本（https://nodejs.org）。',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo 没有找到 Node.js。请先到 https://nodejs.org 安装 18 或更高版本，再双击本文件。',
    '  pause',
    '  exit /b 1',
    ')',
    'echo 正在启动装修设计器…（关闭此窗口或按 Ctrl+C 即停止服务）',
    'start "" /b node serve.mjs',
    'timeout /t 1 >nul',
    'start "" "http://127.0.0.1:5180"',
    'pause',
    ''].join('\r\n'),
);

// 5. 使用说明（换电脑步骤按方案 9.6）
writeFileSync(
  join(outDir, '使用说明.txt'),
  `装修设计器 v${pkg.version} —— 使用说明

【第一次运行前】
1. 电脑需要装有 Node.js 18 或更高版本：到 https://nodejs.org 下载安装，一路“下一步”即可。
2. 把整个「装修设计器-v${pkg.version}」文件夹放在任意位置，不要拆散里面的文件。

【启动】
- macOS：双击「启动.command」。
  第一次运行可能被系统拦截为“来自身份不明的开发者”：请在文件夹里右键点「启动.command」，
  选「打开」，再点一次「打开」即可。
- Windows：双击「启动.bat」。
- 启动后会自动打开浏览器；没有自动打开时，手动访问：http://127.0.0.1:5180
- 关闭启动脚本的黑窗口（或按 Ctrl+C）即停止服务。

【重要：数据存在浏览器里，按网址存放】
- 始终用 http://127.0.0.1:5180 打开。不要换端口、不要用 localhost 或无痕窗口，否则看不到之前的设计。
- 建议定期用右上角菜单（⋯）里的「导出项目包」留一份备份文件。

【使用边界】
- 尺寸和布局仅用于装修效果展示，不能作为承重判断、消防合规、结构安全或施工依据。

【换一台电脑】
1. 旧电脑：菜单（⋯）→ 导出项目包，得到「设计名-日期-时间.rdproj.zip」。
2. 把「装修设计器-v${pkg.version}」文件夹和项目包文件一起拷到新电脑。
3. 新电脑双击启动后：菜单（⋯）→ 导入项目包，选择那个 zip 文件。
4. 历史版本不随项目包走（VER-08）：换电脑后从当前设计开始重新积累。

【常见问题】
- 提示“5180 端口已被占用”：多半是程序已经在运行，直接打开 http://127.0.0.1:5180 即可；
  否则请关闭占用该端口的程序后再启动。
- 浏览器清除了网站数据会导致设计丢失：程序启动时已申请持久存储，
  浏览器仍可能拒绝；所以请保持定期导出备份的习惯。
`,
);

console.log(`程序包已生成：${outDir}`);
console.log('把整个文件夹拷到目标电脑，双击「启动.command」（macOS）或「启动.bat」（Windows）即可使用。');
