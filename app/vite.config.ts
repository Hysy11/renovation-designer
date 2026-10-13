import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  // 程序版本号注入 src/version.ts（构建与测试都生效），避免在代码里硬编码两份
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  server: { port: 5173, strictPort: false },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
