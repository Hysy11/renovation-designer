import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createDesignStore } from '../src/store/designStore';
import { openDesignDB, saveCurrent } from '../src/persistence/db';
import { loadOrCreate, startAutosave } from '../src/persistence/autosave';
import { twoRooms } from './fixtures';

// 测试环境用内存版 IndexedDB 模拟；真实浏览器中的刷新恢复在验收清单中手动验证
describe('自动保存与刷新恢复', () => {
  it('修改后自动写入；“刷新”后读出同一份设计', async () => {
    const db = await openDesignDB();
    const first = await loadOrCreate(db);
    expect(first.design.rooms).toEqual([]);

    const store = createDesignStore(first.design);
    store.actions.setMode('edit');
    const saver = startAutosave(store, db, { delay: 10 });
    store.actions.commit([{ op: 'room.add', room: { usage: 'living', x: 0, y: 0, length: 5000, width: 4000 } }]);
    expect(store.getState().save.status).toBe('unsaved');
    await saver.flushNow();
    expect(store.getState().save.status).toBe('saved');
    saver.stop();
    db.close();

    const db2 = await openDesignDB();
    const again = await loadOrCreate(db2);
    expect(again.design).toEqual(store.getState().design);
    db2.close();
  });

  it('连续修改只写最后一次；试看不触发保存', async () => {
    const db = await openDesignDB();
    const store = createDesignStore(twoRooms());
    store.actions.setMode('edit');
    let writes = 0;
    const counted = new Proxy(db, { get: (t, k) => (k === 'put' ? (...args: unknown[]) => { writes++; return (t.put as (...a: unknown[]) => unknown)(...args); } : Reflect.get(t, k)) });
    const saver = startAutosave(store, counted, { delay: 30 });
    for (let i = 0; i < 5; i++) store.actions.commit([{ op: 'room.update', id: 'r_a', set: { name: `客厅${i}` } }]);
    await new Promise((r) => setTimeout(r, 80));
    await saver.flushNow();
    expect(writes).toBe(1);
    store.actions.startTrial('ai', [{ op: 'room.update', id: 'r_a', add: { width: 300 } }]);
    await new Promise((r) => setTimeout(r, 80));
    expect(writes).toBe(1);
    saver.stop();
    db.close();
  });

  it('读不出来的数据先备份再从空白开始', async () => {
    const db = await openDesignDB();
    await saveCurrent(db, { schemaVersion: 99 } as never, 'x');
    const r = await loadOrCreate(db);
    expect(r.notice).toContain('请先更新程序');
    expect(r.design.rooms).toEqual([]);
    const versions = await db.getAll('versions');
    expect(versions.some((v) => v.kind === 'backup')).toBe(true);
    db.close();
  });
});
