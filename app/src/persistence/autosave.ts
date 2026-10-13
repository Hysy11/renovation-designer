// 自动保存与启动恢复（方案 9.2 节）：每次成功修改后等 1 秒写入，连续修改只写最后一次。
// 只写当前设计；试看和历史查看不会触发保存。
import type { Design } from '../model/schema';
import { createEmptyDesign } from '../model/defaults';
import { migrateAndCheck } from '../engine/load';
import type { DesignStore } from '../store/designStore';
import { loadCurrentRaw, putVersion, saveCurrent, type DB } from './db';

export const AUTOSAVE_DELAY_MS = 1000;

export interface Startup { design: Design; notice?: string }

/** 启动时读取上次的设计；读不出来时把原数据备份为一个历史版本，再从空白开始 */
export async function loadOrCreate(db: DB, now = () => new Date().toISOString()): Promise<Startup> {
  const rec = await loadCurrentRaw(db);
  if (!rec) return { design: createEmptyDesign(now()) };
  const r = migrateAndCheck(rec.design);
  if (r.ok) return { design: r.design };
  const at = now();
  await putVersion(db, { id: `v_backup_${Date.parse(at)}`, name: '无法读取的数据备份', createdAt: at, kind: 'backup', reason: r.reason, design: rec.design });
  return { design: createEmptyDesign(at), notice: `上次保存的设计无法读取（${r.reason}），原数据已备份到历史版本，现在从空白设计开始` };
}

export function startAutosave(store: DesignStore, db: DB, opts: { delay?: number; now?: () => string } = {}) {
  const delay = opts.delay ?? AUTOSAVE_DELAY_MS;
  const now = opts.now ?? (() => new Date().toISOString());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();

  const flush = () => {
    timer = undefined;
    const design = store.getState().design;
    store.actions.setSave({ ...store.getState().save, status: 'saving' });
    pending = saveCurrent(db, design, now())
      .then(() => {
        // 保存期间又有新修改时，保持“未保存”，等下一次写入
        if (store.getState().design === design) store.actions.setSave({ status: 'saved', savedAt: now() });
      })
      .catch((e: unknown) => {
        store.actions.setSave({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      });
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.design === prev.design) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delay);
  });

  return {
    stop() { unsubscribe(); if (timer) clearTimeout(timer); },
    /** 立即写入（关闭页面前、测试中） */
    async flushNow() { if (timer) { clearTimeout(timer); flush(); } await pending; },
  };
}

/** 请求浏览器不要在空间紧张时自动清理本站数据；浏览器可能拒绝 */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
