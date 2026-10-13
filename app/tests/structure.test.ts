// 结构检查（方案第 14 节“结构”一行）：纯逻辑目录不得引用界面、3D、浏览器存储这些东西，
// 保证它们在任何环境（包括单元测试）都能直接运行。
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PURE_DIRS = ['model', 'geometry', 'engine', 'catalog'];
const BANNED_PACKAGES = ['react', 'react-dom', 'three', 'zustand', 'idb'];
const BANNED_DIRS = ['ui', 'plan', 'scene3d', 'persistence', 'store'];
const BANNED_GLOBALS = ['window.', 'document.', 'navigator.', 'localStorage', 'indexedDB', 'requestAnimationFrame'];

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : [p];
  });
}

const files = PURE_DIRS.flatMap((d) => listFiles(join(SRC, d)).map((f) => ({ dir: d, file: f })));

describe('纯逻辑目录的边界', () => {
  it('四个目录里确实有文件被检查到', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const { dir, file } of files) {
    it(`${dir}/${file.slice(SRC.length + 1)} 的依赖干净`, () => {
      const text = readFileSync(file, 'utf8');
      const sources = [...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const src of sources) {
        const pkg = src.startsWith('@') ? src.split('/').slice(0, 2).join('/') : src.split('/')[0]!;
        expect(BANNED_PACKAGES, `引用了 ${src}`).not.toContain(pkg);
        if (src.startsWith('.')) {
          for (const banned of BANNED_DIRS) expect(src, `引用了 ${src}`).not.toMatch(new RegExp(`(^|/)${banned}/`));
        }
      }
      for (const g of BANNED_GLOBALS) expect(text, `使用了浏览器对象 ${g}`).not.toContain(g);
    });
  }
});
