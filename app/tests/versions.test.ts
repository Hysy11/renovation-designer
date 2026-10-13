import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDesignDB, type DB } from '../src/persistence/db';
import {
  AUTO_VERSION_LIMIT, deleteVersion, listVersions, renameVersion, saveVersion, trimAutoVersions,
} from '../src/persistence/versions';
import { twoRooms } from './fixtures';

/** 与 versions.ts 的默认命名一致：本地时间「YYYY-MM-DD HH:mm」，避免测试受时区影响 */
const localName = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

let db: DB;
beforeEach(async () => {
  db = await openDesignDB();
  // fake-indexeddb 在同一测试文件里共用一份数据，先清空保证各用例互不干扰
  await db.clear('current');
  await db.clear('versions');
  await db.clear('thumbs');
  await db.clear('prefs');
});

describe('历史版本（VER-01～08）', () => {
  it('保存手动版本：可命名，未填名称按时间命名；列表新的在前', async () => {
    let t = 0;
    const now = () => new Date(Date.parse('2026-10-13T10:00:00Z') + t++ * 60000).toISOString();
    const a = await saveVersion(db, { design: twoRooms(), kind: 'manual', name: '客厅方案A' }, now);
    const b = await saveVersion(db, { design: twoRooms(), kind: 'manual' }, now);
    expect(a.ok && b.ok).toBe(true);
    const list = await listVersions(db);
    expect(list.map((v) => v.name)).toEqual([localName('2026-10-13T10:01:00.000Z'), '客厅方案A']); // 新→旧；未命名按时间
    expect(list.every((v) => v.kind === 'manual')).toBe(true);
  });

  it('自动版本只保留最近 20 个，手动与备份不动（VER-07）', async () => {
    let t = 0;
    const now = () => new Date(Date.parse('2026-10-13T10:00:00Z') + t++ * 60000).toISOString();
    await saveVersion(db, { design: twoRooms(), kind: 'manual', name: '手动' }, now);
    await saveVersion(db, { design: twoRooms(), kind: 'backup', reason: '兜底' }, now);
    for (let i = 0; i < AUTO_VERSION_LIMIT + 5; i++) {
      const r = await saveVersion(db, { design: twoRooms(), kind: 'auto', reason: '应用 AI 修改前' }, now);
      expect(r.ok).toBe(true);
    }
    const list = await listVersions(db);
    expect(list.filter((v) => v.kind === 'auto')).toHaveLength(AUTO_VERSION_LIMIT);
    expect(list.filter((v) => v.kind === 'manual')).toHaveLength(1);
    expect(list.filter((v) => v.kind === 'backup')).toHaveLength(1);
    // 时间线：10:00 手动、10:01 备份、10:02–10:26 共 25 个自动版本；
    // 每次自动保存后裁剪，最早的 5 个（10:02–10:06）被删，留下 10:07–10:26
    const autos = list.filter((v) => v.kind === 'auto');
    expect(autos.at(-1)!.name).toBe(localName('2026-10-13T10:07:00.000Z'));
  });

  it('改名与删除；删除同时清掉缩略图', async () => {
    const r = await saveVersion(db, { design: twoRooms(), kind: 'manual', name: '旧名' });
    const id = r.record!.id;
    await db.put('thumbs', new Blob(['x'], { type: 'text/plain' }), id);
    expect(await renameVersion(db, id, '  新名字  ')).toBe(true);
    expect((await listVersions(db))[0]!.name).toBe('新名字');
    expect(await renameVersion(db, id, '  ')).toBe(false); // 空名不改
    await deleteVersion(db, id);
    expect(await listVersions(db)).toHaveLength(0);
    expect(await db.get('thumbs', id)).toBeUndefined();
  });

  it('同一毫秒保存两次不撞号', async () => {
    const fixed = () => '2026-10-13T10:00:00.000Z';
    const a = await saveVersion(db, { design: twoRooms(), kind: 'manual', name: 'A' }, fixed);
    const b = await saveVersion(db, { design: twoRooms(), kind: 'manual', name: 'B' }, fixed);
    expect(a.record!.id).not.toBe(b.record!.id);
    expect(await listVersions(db)).toHaveLength(2);
  });

  it('空间超过 90% 时拒绝保存并说明（不静默丢弃）', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 95, quota: 100 }) } });
    const r = await saveVersion(db, { design: twoRooms(), kind: 'manual', name: 'X' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('90%');
    vi.unstubAllGlobals();
  });

  it('trimAutoVersions 也可单独调用（返回清理数量）', async () => {
    let t = 0;
    const now = () => new Date(Date.parse('2026-10-13T10:00:00Z') + t++ * 60000).toISOString();
    for (let i = 0; i < 3; i++) await saveVersion(db, { design: twoRooms(), kind: 'auto' }, now);
    // 直接再塞 25 个不经过 saveVersion 的自动版本，验证裁剪函数本身
    for (let i = 0; i < 25; i++) {
      await db.put('versions', { id: `raw_${i}`, name: `raw${i}`, createdAt: new Date(Date.parse('2026-10-12T10:00:00Z') + i * 60000).toISOString(), kind: 'auto', design: {} });
    }
    const removed = await trimAutoVersions(db);
    expect(removed).toBe(8); // 3 + 25 = 28，留 20
    expect((await listVersions(db)).filter((v) => v.kind === 'auto')).toHaveLength(AUTO_VERSION_LIMIT);
  });
});
