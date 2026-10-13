import { describe, expect, it, vi } from 'vitest';
import { can, createDesignStore, displayDesign, proposeConflicts, UNDO_LIMIT, type Action } from '../src/store/designStore';
import { sequentialIds } from '../src/model/ids';
import type { Op } from '../src/engine/ops';
import { twoRooms } from './fixtures';

function setup(opts: { clock?: () => number } = {}) {
  const autoVersion = vi.fn(() => true);
  const store = createDesignStore(twoRooms(), { engine: { genId: sequentialIds() }, autoVersion, clock: opts.clock });
  store.actions.setMode('edit');
  return { store, a: store.actions, s: () => store.getState(), autoVersion };
}

const widen: Op[] = [{ op: 'room.update', id: 'r_a', add: { width: 300 } }];

describe('第 8.2 节表格：每种状态下的允许与禁止', () => {
  const table: Record<Action, [boolean, boolean, boolean]> = {
    // [无叠加, 试看中, 历史查看中]
    edit: [true, true, false],
    startTrial: [true, false, false],
    openHistory: [true, false, true],
    importExport: [true, false, false],
    saveVersion: [true, false, false],
    undo: [true, true, false],
    chat: [true, true, true],
    chatPropose: [true, true, false],
  };
  for (const [action, expected] of Object.entries(table) as [Action, [boolean, boolean, boolean]][]) {
    it(action, () => {
      const { a, s } = setup();
      const none = can(s(), action).ok;
      a.startTrial('ai', widen);
      const trial = can(s(), action).ok;
      a.discardTrial();
      a.openHistory('v1', '版本 1', twoRooms());
      const history = can(s(), action).ok;
      expect([none, trial, history]).toEqual(expected);
      if (!history) expect(can(s(), action).reason).toBeTruthy();
    });
  }

  it('禁止的操作在状态层也真的被拒绝', () => {
    const { a, s } = setup();
    a.openHistory('v1', '版本 1', twoRooms());
    expect(a.commit(widen).ok).toBe(false);
    expect(a.startTrial('ai', widen).message).toContain('历史版本');
    expect(a.undo()).toBe(false);
    a.exitHistory();
    a.startTrial('ai', widen);
    expect(a.openHistory('v1', '版本 1', twoRooms()).ok).toBe(false);
    expect(a.startTrial('style', widen).message).toBe('已有一个试看方案，请先应用或放弃');
    expect(s().session.overlay.type).toBe('trial');
  });

  it('预览模式下不能手动修改', () => {
    const { a } = setup();
    a.setMode('preview');
    expect(a.commit(widen)).toMatchObject({ ok: false, message: '当前是预览模式，请先切换到编辑模式' });
  });
});

describe('撤销与重做', () => {
  it('撤销、重做、新修改清空重做', () => {
    const { a, s } = setup();
    a.commit(widen);
    a.commit([{ op: 'room.update', id: 'r_b', set: { name: '主卧' } }]);
    expect(a.undo()).toBe(true);
    expect(s().design.rooms[1]!.name).toBe('卧室');
    expect(a.redo()).toBe(true);
    expect(s().design.rooms[1]!.name).toBe('主卧');
    a.undo();
    a.commit([{ op: 'room.update', id: 'r_b', set: { name: '次卧' } }]);
    expect(a.redo()).toBe(false);
  });

  it(`最多 ${UNDO_LIMIT} 步`, () => {
    const { a, s } = setup();
    for (let i = 0; i < UNDO_LIMIT + 5; i++) a.commit([{ op: 'room.update', id: 'r_a', set: { name: `客厅${i}` } }]);
    expect(s().past).toHaveLength(UNDO_LIMIT);
  });

  it('方向键连续微调 0.5 秒内合并为一步', () => {
    let t = 0;
    const { a, s } = setup({ clock: () => t });
    for (let i = 0; i < 5; i++) { a.commit([{ op: 'room.update', id: 'r_b', add: { y: 10 } }], { mergeKey: 'nudge:r_b' }); t += 200; }
    expect(s().past).toHaveLength(1);
    t += 600;
    a.commit([{ op: 'room.update', id: 'r_b', add: { y: 10 } }], { mergeKey: 'nudge:r_b' });
    expect(s().past).toHaveLength(2);
    a.undo(); a.undo();
    expect(s().design.rooms[1]!.y).toBe(0);
  });

  it('失败的修改不进撤销栈，原设计不变', () => {
    const { a, s } = setup();
    const before = s().design;
    expect(a.commit([{ op: 'room.update', id: 'r_b', add: { x: -500 } }]).ok).toBe(false);
    expect(s().design).toBe(before);
    expect(s().past).toHaveLength(0);
  });

  it('选中的对象被删除或撤销掉后自动取消选中', () => {
    const { a, s } = setup();
    a.commit([{ op: 'room.add', room: { usage: 'kitchen', x: 0, y: 4000, length: 3000, width: 2000 } }]);
    a.select({ kind: 'room', id: 'r_1' });
    a.undo();
    expect(s().session.selection).toBeNull();
  });
});

describe('试看（方案 8.3 节）', () => {
  it('试看不改当前设计；显示用设计是候选', () => {
    const { a, s } = setup();
    a.startTrial('ai', widen);
    expect(s().design.rooms[0]!.width).toBe(4000);
    expect(displayDesign(s()).rooms[0]!.width).toBe(4300);
  });

  it('试看期间手动改了别的对象：重放，不过期', () => {
    const { a, s } = setup();
    a.startTrial('ai', widen);
    a.commit([{ op: 'room.update', id: 'r_b', set: { name: '主卧' } }]);
    const o = s().session.overlay;
    expect(o.type === 'trial' && !o.stale && o.candidate.rooms[1]!.name === '主卧' && o.candidate.rooms[0]!.width === 4300).toBe(true);
  });

  it('试看要改的字段被手动改过：过期，不能应用', async () => {
    const { a, s } = setup();
    a.startTrial('ai', widen);
    a.commit([{ op: 'room.update', id: 'r_a', set: { width: 3800 } }]);
    const o = s().session.overlay;
    expect(o.type === 'trial' && o.stale).toBe(true);
    expect(o.type === 'trial' && o.staleReason).toContain('客厅');
    const r = await a.applyTrial();
    expect(r.ok).toBe(false);
    expect(s().design.rooms[0]!.width).toBe(3800);
  });

  it('重放后不再合法：过期并说明原因', () => {
    const { a, s } = setup();
    a.startTrial('ai', [{ op: 'room.update', id: 'r_b', set: { name: '主卧' } }, { op: 'furniture.add', furniture: { templateId: 'bed.double', roomId: 'r_b', cx: 6750, cy: 2000 } }]);
    a.commit([{ op: 'room.update', id: 'r_b', set: { width: 2000 } }]); // 床放不下了
    const o = s().session.overlay;
    expect(o.type === 'trial' && o.stale && o.staleReason?.startsWith('当前设计已变化')).toBe(true);
  });

  it('撤销当前设计上的手动修改，试看随之重算', () => {
    const { a, s } = setup();
    a.commit([{ op: 'room.update', id: 'r_b', set: { name: '主卧' } }]);
    a.startTrial('ai', widen);
    a.undo();
    const o = s().session.overlay;
    expect(o.type === 'trial' && !o.stale && o.candidate.rooms[1]!.name === '卧室').toBe(true);
  });

  it('预览模式中应用：先切编辑模式、先存自动版本、记一步撤销', async () => {
    const { a, s, autoVersion } = setup();
    a.setMode('preview');
    a.startTrial('ai', widen);
    const r = await a.applyTrial();
    expect(r).toMatchObject({ ok: true, message: '已应用 1 项修改，已切换到编辑模式，可以撤销' });
    expect(autoVersion).toHaveBeenCalledWith(expect.objectContaining({ revision: 0 }), '应用 AI 修改前');
    expect(s().session.mode).toBe('edit');
    expect(s().design.rooms[0]!.width).toBe(4300);
    expect(s().session.overlay.type).toBe('none');
    a.undo();
    expect(s().design.rooms[0]!.width).toBe(4000);
  });

  it('自动版本保存失败且用户取消时不应用', async () => {
    const store = createDesignStore(twoRooms(), { autoVersion: () => false });
    store.actions.startTrial('style', [{ op: 'style.applyPreset', presetId: 'mid-century-minimal' }]);
    expect((await store.actions.applyTrial()).message).toBe('已取消应用，设计未改变');
    expect(store.getState().session.overlay.type).toBe('trial');
  });

  it('放弃：不留任何记录', () => {
    const { a, s } = setup();
    const before = s().design;
    a.startTrial('ai', widen);
    expect(a.discardTrial().message).toBe('已放弃本次修改，设计未改变');
    expect(s().design).toBe(before);
    expect(s().past).toHaveLength(0);
  });

  it('不合法的方案不会进入试看', () => {
    const { a, s } = setup();
    const r = a.startTrial('ai', [{ op: 'room.update', id: 'r_b', add: { x: -500 } }]);
    expect(r.ok).toBe(false);
    expect(r.errors![0]!.code).toBe('ROOM_OVERLAP');
    expect(s().session.overlay.type).toBe('none');
  });
});

describe('等待期冲突（方案 10.4：提议撞上等待期间的手动修改则不生成试看）', () => {
  it('撞同一对象同一字段 → 冲突；不相干修改 → 放行；同对象不同字段 → 放行', () => {
    const { a, s } = setup();
    const base = s().design;
    a.commit([{ op: 'room.update', id: 'r_b', set: { name: '主卧' } }]); // “模型思考期间”的手动修改
    expect(proposeConflicts(base, s().design, widen)).toBe(false); // 提议动 r_a，手动动的是 r_b：放行
    expect(proposeConflicts(base, s().design, [{ op: 'room.update', id: 'r_b', set: { name: '次卧' } }])).toBe(true); // 撞 r_b:name
    expect(proposeConflicts(base, s().design, [{ op: 'room.update', id: 'r_b', add: { width: 100 } }])).toBe(false); // 同对象不同字段
  });

  it('提议在当前设计上本来就检查不过 → 交回常规报错路径，不算冲突', () => {
    const { a, s } = setup();
    const base = s().design;
    a.commit([{ op: 'room.update', id: 'r_b', set: { name: '主卧' } }]);
    expect(proposeConflicts(base, s().design, [{ op: 'room.remove', id: '不存在' }])).toBe(false);
  });

  it('设计没变时恒为放行', () => {
    const { s } = setup();
    expect(proposeConflicts(s().design, s().design, widen)).toBe(false);
  });
});

describe('历史版本恢复与整份替换', () => {
  it('恢复历史版本：先存自动版本，可撤销', async () => {
    const { a, s, autoVersion } = setup();
    const old = twoRooms();
    old.rooms[0]!.name = '旧客厅';
    a.commit(widen);
    a.openHistory('v1', '版本 1', old);
    expect(displayDesign(s()).rooms[0]!.name).toBe('旧客厅');
    const r = await a.restoreHistory();
    expect(r.ok).toBe(true);
    expect(autoVersion).toHaveBeenLastCalledWith(expect.anything(), '恢复版本前');
    expect(s().design.rooms[0]!.name).toBe('旧客厅');
    expect(s().design.revision).toBe(2);
    a.undo();
    expect(s().design.rooms[0]!.width).toBe(4300);
  });

  it('不合法的设计拒绝替换', async () => {
    const { a } = setup();
    const bad = twoRooms();
    bad.rooms[1]!.x = 4000;
    const r = await a.replaceDesign(bad, '导入替换前');
    expect(r.ok).toBe(false);
    expect(r.errors![0]!.code).toBe('ROOM_OVERLAP');
  });

  it('预览模式恢复历史版本：恢复后先切到编辑模式（VER-05）', async () => {
    const { a, s, autoVersion } = setup();
    a.setMode('preview');
    const old = twoRooms();
    old.rooms[0]!.name = '旧客厅';
    a.openHistory('v1', '版本 1', old);
    const r = await a.restoreHistory();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('已切换到编辑模式');
    expect(s().session.mode).toBe('edit');
    expect(autoVersion).toHaveBeenLastCalledWith(expect.anything(), '恢复版本前');
  });

  it('恢复版本前自动版本失败且用户取消：不替换、仍在历史查看', async () => {
    const store = createDesignStore(twoRooms(), { engine: { genId: sequentialIds() }, autoVersion: () => false });
    store.actions.setMode('edit');
    const old = twoRooms();
    old.rooms[0]!.name = '旧客厅';
    store.actions.openHistory('v1', '版本 1', old);
    const r = await store.actions.restoreHistory();
    expect(r).toMatchObject({ ok: false, message: '已取消' });
    expect(store.getState().design.rooms[0]!.name).toBe('客厅');
    expect(store.getState().session.overlay.type).toBe('history');
  });
});

describe('风险操作前自动备份（VER-02 的 commitWithBackup）', () => {
  const removeB: Op[] = [{ op: 'room.remove', id: 'r_b' }];

  it('先存自动版本（带原因）再执行；可撤销', async () => {
    const { a, s, autoVersion } = setup();
    const r = await a.commitWithBackup(removeB, '删除房间前');
    expect(r.ok).toBe(true);
    expect(autoVersion).toHaveBeenCalledWith(expect.objectContaining({ revision: 0 }), '删除房间前');
    expect(s().design.rooms).toHaveLength(1);
    a.undo();
    expect(s().design.rooms).toHaveLength(2);
  });

  it('用户取消：操作不执行，设计不变', async () => {
    const store = createDesignStore(twoRooms(), { engine: { genId: sequentialIds() }, autoVersion: () => false });
    store.actions.setMode('edit');
    const before = store.getState().design;
    const r = await store.actions.commitWithBackup(removeB, '删除房间前');
    expect(r).toMatchObject({ ok: false, message: '已取消，设计未改变' });
    expect(store.getState().design).toBe(before);
    expect(store.getState().past).toHaveLength(0);
  });

  it('检查不通过时直接拒绝，不触发自动版本', async () => {
    const { a, autoVersion } = setup();
    const r = await a.commitWithBackup([{ op: 'room.update', id: 'r_b', add: { x: -500 } }], '删除房间前');
    expect(r.ok).toBe(false);
    expect(autoVersion).not.toHaveBeenCalled();
  });

  it('预览模式下不能用（与其他修改一样）', async () => {
    const { a } = setup();
    a.setMode('preview');
    const r = await a.commitWithBackup(removeB, '删除房间前');
    expect(r).toMatchObject({ ok: false, message: '当前是预览模式，请先切换到编辑模式' });
  });
});
