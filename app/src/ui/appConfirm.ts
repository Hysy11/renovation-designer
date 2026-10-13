// 承诺式确认框桥：状态层的 autoVersion 依赖（VER-02）在保存失败时需要用户选“继续还是取消”，
// 但 store 建立在 React 渲染之前。AppShell 挂载后注册渲染器；未注册时退回 window.confirm。
export interface AppConfirmSpec { title: string; lines?: string[]; confirmText?: string }

let renderer: ((spec: AppConfirmSpec) => Promise<boolean>) | null = null;

export function registerAppConfirm(fn: (spec: AppConfirmSpec) => Promise<boolean>) {
  renderer = fn;
}
export function unregisterAppConfirm(fn: (spec: AppConfirmSpec) => Promise<boolean>) {
  if (renderer === fn) renderer = null;
}

export function appConfirm(spec: AppConfirmSpec): Promise<boolean> {
  if (renderer) return renderer(spec);
  const text = [spec.title, ...(spec.lines ?? [])].join('\n');
  return Promise.resolve(window.confirm(text));
}
