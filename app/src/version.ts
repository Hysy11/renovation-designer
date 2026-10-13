// 程序版本号：构建/测试时由 vite.config.ts 的 define 注入；直接运行源码时兜底为 0.0.0
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'undefined' ? '0.0.0' : __APP_VERSION__;
