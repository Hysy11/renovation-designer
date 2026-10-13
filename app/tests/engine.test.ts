import { describe, expect, it } from 'vitest';
import { applyOps, planRoomRemoval } from '../src/engine/apply';
import { affectedObjects, furniturePart, wallColor } from '../src/engine/appearance';
import { sequentialIds } from '../src/model/ids';
import { Design as DesignSchema, type Design } from '../src/model/schema';
import { deriveWalls } from '../src/geometry/walls';
import { design, door, furn, NOW, room, twoRooms, windowOf } from './fixtures';

const opts = () => ({ genId: sequentialIds(), now: () => '2026-10-11T08:00:00.000Z' });
const run = (d: Design, ops: unknown) => applyOps(d, ops, opts());
const ok = (d: Design, ops: unknown) => {
  const r = run(d, ops);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('\n'));
  return r;
};

describe('格式检查', () => {
  it('未知指令、未知字段、错误类型一律拒绝，并给中文原因', () => {
    const d = twoRooms();
    const r1 = run(d, [{ op: 'room.rotate', id: 'r_a' }]);
    expect(r1.ok).toBe(false);
    expect(r1.errors[0]!.message).toContain('不认识的指令');
    expect(r1.errors[0]!.hint).toContain('room.add');
    const r2 = run(d, [{ op: 'room.update', id: 'r_a', set: { length: 5000, color: '#fff' } }]);
    expect(r2.errors[0]!.message).toMatch(/第 1 条指令（room.update） 的 set：.*color/);
    const r3 = run(d, [{ op: 'room.update', id: 'r_a', set: { length: 5000.5 } }]);
    expect(r3.ok).toBe(false);
    expect(run(d, []).ok).toBe(false);
  });
});

describe('房间指令', () => {
  it('新增：默认名称和颜色，编号带前缀，版本号 +1，差异列表', () => {
    const r = ok(design(), [{ op: 'room.add', room: { usage: 'bedroom', x: 0, y: 0, length: 3500, width: 4000 } }]);
    expect(r.next!.rooms[0]).toMatchObject({ id: 'r_1', name: '卧室', planColor: '#F3EEFF' });
    expect(r.next!.revision).toBe(1);
    expect(r.next!.meta.updatedAt).toBe('2026-10-11T08:00:00.000Z');
    expect(r.changes.map((c) => c.text)).toEqual(['新增房间「卧室」（3500 × 4000 mm）']);
  });

  it('add 增量：客厅加宽 300', () => {
    const r = ok(twoRooms(), [{ op: 'room.update', id: 'r_a', add: { width: 300 } }]);
    expect(r.next!.rooms[0]!.width).toBe(4300);
    expect(r.changes.find((c) => c.field === 'width')!.text).toBe('房间「客厅」宽：4000 mm → 4300 mm');
  });

  it('移动房间：所属家具保持相对位置跟随（需求 4.2），差异列表不逐件罗列', () => {
    let d = twoRooms();
    d = ok(d, [{ op: 'furniture.add', furniture: { templateId: 'sofa.3seat', roomId: 'r_a', cx: 2500, cy: 3000 } }]).next!;
    const before = d.furniture[0]!;
    const r = ok(d, [{ op: 'room.update', id: 'r_a', set: { x: -1000, y: 500 } }]);
    expect(r.next!.furniture[0]!).toMatchObject({ cx: before.cx - 1000, cy: before.cy + 500 });
    expect(r.changes.map((c) => c.text)).toEqual([
      '房间「客厅」位置 x：0 mm → -1000 mm',
      '房间「客厅」位置 y：0 mm → 500 mm',
    ]);
  });

  it('改长宽不拉伸家具：家具被挤出时给出冲突', () => {
    let d = twoRooms();
    d = ok(d, [{ op: 'furniture.add', furniture: { templateId: 'sofa.3seat', roomId: 'r_a', cx: 3700, cy: 3000 } }]).next!;
    const r = run(d, [{ op: 'room.update', id: 'r_a', set: { length: 4000 } }]); // 沙发出界
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.code).toBe('FURN_OUT_OF_ROOM');
  });

  it('整批原子性：后一条出错，前一条也不生效，原设计不变', () => {
    const d = twoRooms();
    const r = run(d, [
      { op: 'room.update', id: 'r_a', set: { name: '大客厅' } },
      { op: 'room.update', id: 'r_b', add: { x: -500 } }, // 与客厅重叠
    ]);
    expect(r.ok).toBe(false);
    expect(r.next).toBeUndefined();
    expect(r.errors.map((e) => e.code)).toEqual(['ROOM_OVERLAP']);
    expect(d.rooms[0]!.name).toBe('客厅');
  });

  it('找不到对象', () => {
    const r = run(twoRooms(), [{ op: 'room.remove', id: 'r_zz' }]);
    expect(r.errors[0]).toMatchObject({ code: 'NOT_FOUND', message: '第 1 条指令：找不到房间 r_zz' });
  });

  it('没有实际变化时不增加版本号', () => {
    const d = twoRooms();
    const r = ok(d, [{ op: 'room.update', id: 'r_a', set: { length: 5000 } }]);
    expect(r.changes).toEqual([]);
    expect(r.next).toBe(d);
  });

  it('墙面颜色按边合并，null 恢复跟随风格', () => {
    let d = ok(twoRooms(), [{ op: 'room.update', id: 'r_a', set: { wallColors: { right: '#AA0000', top: '#00AA00' } } }]).next!;
    d = ok(d, [{ op: 'room.update', id: 'r_a', set: { wallColors: { top: null } } }]).next!;
    expect(d.rooms[0]!.wallColors).toEqual({ right: '#AA0000' });
    // 共用墙两侧颜色不同（WALL-03）
    expect(wallColor(d, d.rooms[0]!, 'right')).toBe('#AA0000');
    expect(wallColor(d, d.rooms[1]!, 'left')).toBe(d.style.palette.wallColor);
  });
});

describe('临时编号', () => {
  it('同一批先加房间再在里面加门和家具', () => {
    const r = ok(design(), [
      { op: 'room.add', tempId: 'new:bed', room: { usage: 'bedroom', x: 0, y: 0, length: 3500, width: 4000 } },
      { op: 'opening.add', opening: { kind: 'door', hostRoomId: 'new:bed', side: 'bottom', offset: 300, use: 'entry' } },
      { op: 'furniture.add', tempId: 'new:b1', furniture: { templateId: 'bed.double', roomId: 'new:bed', cx: 1750, cy: 1200 } },
      { op: 'wall.update', id: 'ext:new:bed:top', set: { height: 3000 } },
    ]);
    expect(r.created).toEqual({ 'new:bed': 'r_1', 'new:b1': 'f_3' });
    expect(r.next!.openings[0]).toMatchObject({ hostRoomId: 'r_1', openMode: 'swing', hinge: 'start', swingInto: 'host', width: 900, height: 2100, sill: 0 });
    expect(r.next!.furniture[0]).toMatchObject({ roomId: 'r_1', l: 1800, w: 2000, h: 450, name: '双人床' });
    expect(r.next!.walls).toEqual({ 'ext:r_1:top': { height: 3000 } });
  });

  it('引用还没创建的临时编号报错', () => {
    const r = run(design(), [{ op: 'furniture.add', furniture: { templateId: 'bed.double', roomId: 'new:x', cx: 0, cy: 0 } }]);
    expect(r.errors[0]!.code).toBe('TEMP_ID_UNKNOWN');
  });
});

describe('墙指令', () => {
  it('共用墙编号两侧顺序随意；null 恢复默认后记录被删除', () => {
    let d = ok(twoRooms(), [{ op: 'wall.update', id: 'shared:r_b|r_a', set: { thickness: 200 } }]).next!;
    expect(d.walls).toEqual({ 'shared:r_a|r_b': { thickness: 200 } });
    const r = ok(d, [{ op: 'wall.update', id: 'shared:r_a|r_b', add: { thickness: 40 } }]);
    expect(r.changes[0]!.text).toBe('客厅与卧室之间的墙厚度：200 mm → 240 mm');
    d = ok(r.next!, [{ op: 'wall.update', id: 'shared:r_a|r_b', set: { thickness: null } }]).next!;
    expect(d.walls).toEqual({});
  });

  it('房间不再相邻：共用墙设置移除并说明（第 17 节第 3 条）', () => {
    const d = ok(twoRooms(), [{ op: 'wall.update', id: 'shared:r_a|r_b', set: { open: true } }]).next!;
    const r = ok(d, [{ op: 'room.update', id: 'r_b', add: { x: 1000 } }]);
    expect(r.next!.walls).toEqual({});
    expect(r.changes.map((c) => c.text)).toContain('客厅与卧室不再相邻，原共用墙设置已移除');
  });

  it('墙高低于已有窗顶时拒绝（WALL-02）', () => {
    const d = twoRooms();
    d.openings.push(windowOf('o_1', 'r_a', 'top', 500));
    const r = run(d, [{ op: 'wall.update', id: 'ext:r_a:top', set: { height: 2300 } }]);
    expect(r.errors.map((e) => e.code)).toEqual(['OPENING_TOO_TALL']);
    expect(r.errors[0]!.message).toBe('客厅上墙的窗顶部 2400 mm 高出所在墙 2300 mm');
    expect(run(d, [{ op: 'wall.update', id: 'ext:r_a:top', set: { height: 1900 } }]).errors.map((e) => e.code)).toEqual(['WALL_HEIGHT', 'OPENING_TOO_TALL']);
  });

  it('不存在的墙', () => {
    expect(run(twoRooms(), [{ op: 'wall.update', id: 'shared:r_a|r_c', set: { open: true } }]).errors[0]!.code).toBe('NOT_FOUND');
  });
});

describe('门窗指令', () => {
  it('平开改移门时须清掉不适用字段', () => {
    const d = twoRooms();
    d.openings.push(door('o_1', 'r_a', 'right', 1000));
    expect(run(d, [{ op: 'opening.update', id: 'o_1', set: { openMode: 'sliding', slideTo: 'end' } }]).ok).toBe(false);
    const r = ok(d, [{ op: 'opening.update', id: 'o_1', set: { openMode: 'sliding', slideTo: 'end', hinge: null, swingInto: null } }]);
    expect(r.next!.openings[0]).not.toHaveProperty('hinge');
  });

  it('门越界的错误带具体建议', () => {
    const r = run(twoRooms(), [{ op: 'opening.add', opening: { kind: 'door', hostRoomId: 'r_a', side: 'right', offset: 3250 } }]);
    expect(r.errors[0]!.hint).toBe('可以把位置减小到 3100 mm 以内，或把门宽改为 750 mm 以下');
  });

  it('室内门放外墙只提示，可以提交', () => {
    const r = ok(twoRooms(), [{ op: 'opening.add', opening: { kind: 'door', hostRoomId: 'r_a', side: 'bottom', offset: 500 } }]);
    expect(r.warnings.map((w) => w.code)).toEqual(['INTERIOR_DOOR_ON_EXTERIOR']);
  });
});

describe('家具指令', () => {
  const withSofa = () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000, '客厅'), room('r_b', 5000, 0, 3500, 4000, '卧室')] });
    d.furniture.push(furn('f_s', 'r_a', 'sofa.3seat', 2500, 3200, 2200, 900, { name: '沙发', rotation: 180 }));
    return d;
  };

  it('左移 20 厘米 = add cx -200', () => {
    const r = ok(withSofa(), [{ op: 'furniture.update', id: 'f_s', add: { cx: -200 } }]);
    expect(r.next!.furniture[0]!.cx).toBe(2300);
    expect(r.changes[0]!.text).toBe('家具「沙发」位置 x：2500 mm → 2300 mm');
  });

  it('旋转增量规范到 0–359', () => {
    expect(ok(withSofa(), [{ op: 'furniture.update', id: 'f_s', add: { rotation: 540 } }]).next!.furniture[0]!.rotation).toBe(0);
  });

  it('穿墙拒绝', () => {
    expect(run(withSofa(), [{ op: 'furniture.update', id: 'f_s', add: { cy: 500 } }]).errors[0]!.code).toBe('FURN_OUT_OF_ROOM');
  });

  it('移到另一个房间：按新房间检查', () => {
    const r = ok(withSofa(), [{ op: 'furniture.update', id: 'f_s', set: { roomId: 'r_b', cx: 6700, cy: 3200 } }]);
    expect(r.changes.find((c) => c.field === 'roomId')!.text).toBe('家具「沙发」所属房间：「客厅」 → 「卧室」');
    // 卧室净长 3500-60-120=3320，沙发 2200 放得下；改成 3200 也放得下
    expect(run(withSofa(), [{ op: 'furniture.update', id: 'f_s', set: { roomId: 'r_b', cx: 6700, cy: 3200, l: 3200 } }]).ok).toBe(true);
  });

  it('部件外观合并、材质不允许时拒绝', () => {
    let d = ok(withSofa(), [{ op: 'furniture.update', id: 'f_s', set: { appearance: { legs: { material: 'metal' } } } }]).next!;
    expect(furniturePart(d, d.furniture[0]!, 'legs')).toEqual({ color: d.style.palette.woodColor, material: 'metal', inherited: false });
    d = ok(d, [{ op: 'furniture.update', id: 'f_s', set: { appearance: { legs: { material: null } } } }]).next!;
    expect(d.furniture[0]).not.toHaveProperty('appearance');
    expect(run(d, [{ op: 'furniture.update', id: 'f_s', set: { appearance: { legs: { material: 'glass' } } } }]).errors[0]!.code).toBe('FURN_MATERIAL');
  });
});

describe('删除房间（第 17 节第 4 条）', () => {
  it('家具和外墙门窗删除；共用墙门窗转给相邻房间并换算位置', () => {
    // 客厅 0..5000，卧室 5000..8500 × 1000..4000（部分相邻 1000..4000）
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000, '客厅'), room('r_b', 5000, 1000, 3500, 3000, '卧室')] });
    d.openings.push(
      door('o_shared', 'r_b', 'left', 500, 900, { swingInto: 'host' }), // 绝对 y 1500..2400
      windowOf('o_ext', 'r_b', 'right', 500),
    );
    d.furniture.push(furn('f_bed', 'r_b', 'bed.double', 1750, 1500, 1800, 2000, { h: 450 }));
    const plan = planRoomRemoval(d, 'r_b');
    expect(plan).toEqual({
      furniture: ['f_bed'], removedOpenings: ['o_ext'],
      transferred: [{ openingId: 'o_shared', toRoomId: 'r_a', toSide: 'right', offset: 1500 }],
    });
    const r = ok(d, [{ op: 'room.remove', id: 'r_b' }]);
    expect(r.next!.furniture).toEqual([]);
    expect(r.next!.openings).toEqual([{ ...d.openings[0], hostRoomId: 'r_a', side: 'right', offset: 1500, swingInto: 'other' }]);
    // 原共用墙变成客厅外墙，门仍在原来的绝对位置上
    const seg = deriveWalls(r.next!).roomSides.get('r_a')!.right;
    expect(seg.map((s) => s.id)).toEqual(['ext:r_a:right']);
    expect(r.warnings.map((w) => w.code)).toEqual(['INTERIOR_DOOR_ON_EXTERIOR']);
  });
});

describe('风格', () => {
  const styled = () => {
    const d = twoRooms();
    d.furniture.push(
      furn('f_1', 'r_a', 'sofa.3seat', 2500, 2000, 2200, 900, { appearance: { frame: { color: '#123456' }, legs: { material: 'metal' } } }),
      furn('f_2', 'r_a', 'table.coffee', 2500, 800, 1200, 600, { h: 420 }),
    );
    d.rooms[0]!.wallColors = { top: '#AABBCC' };
    return d;
  };

  it('切换预设默认保留单独设置；受影响对象由程序比较得出', () => {
    const d = styled();
    const r = ok(d, [{ op: 'style.applyPreset', presetId: 'mid-century-minimal' }]);
    const n = r.next!;
    expect(n.style.presetId).toBe('mid-century-minimal');
    expect(furniturePart(n, n.furniture[0]!, 'frame')!.color).toBe('#123456');
    expect(furniturePart(n, n.furniture[1]!, 'top')!.color).toBe('#6B4A33');
    expect(n.rooms[0]!.wallColors).toEqual({ top: '#AABBCC' });
    expect(affectedObjects(d, n).map((a) => a.key).sort()).toEqual(['furniture:f_1', 'furniture:f_2', 'room:r_a', 'room:r_b']);
  });

  it('覆盖所有兼容对象：清除单独颜色，保留材质', () => {
    const n = ok(styled(), [{ op: 'style.applyPreset', presetId: 'mid-century-minimal', overrideAll: true }]).next!;
    expect(n.furniture[0]!.appearance).toEqual({ legs: { material: 'metal' } });
    expect(n.rooms[0]).not.toHaveProperty('wallColors');
  });

  it('改风格参数后预设变为自定义；风格指令不能带尺寸', () => {
    const n = ok(twoRooms(), [{ op: 'style.update', set: { palette: { woodColor: '#AA8866' } } }]).next!;
    expect(n.style.presetId).toBe('custom');
    expect(run(twoRooms(), [{ op: 'style.update', set: { length: 100 } }]).ok).toBe(false);
    expect(run(twoRooms(), [{ op: 'style.update', set: { lighting: { colorTemp: 9000 } } }]).errors[0]!.code).toBe('STYLE_COLOR_TEMP');
  });
});

describe('其他指令', () => {
  it('清空设计保留风格与展示设置', () => {
    const d = twoRooms();
    d.style.presetId = 'custom';
    const n = ok(d, [{ op: 'design.clear' }]).next!;
    expect(n.rooms).toEqual([]);
    expect(n.style.presetId).toBe('custom');
  });

  it('改名、默认墙厚、展示参数', () => {
    const r = ok(twoRooms(), [
      { op: 'design.update', set: { name: '新家' } },
      { op: 'defaults.update', set: { exteriorThickness: 300 } },
      { op: 'display.update', set: { base: { height: 500 } } },
    ]);
    expect(r.changes.map((c) => c.text)).toEqual(['设计名称：测试 → 新家', '默认外墙厚：240 mm → 300 mm', '基座高度：450 mm → 500 mm']);
  });

  it('执行结果始终符合数据格式', () => {
    const r = ok(design(), [
      { op: 'room.add', tempId: 'new:a', room: { usage: 'living', x: 0, y: 0, length: 5000, width: 4000 } },
      { op: 'opening.add', opening: { kind: 'window', hostRoomId: 'new:a', side: 'top', offset: 1000, windowType: 'floor' } },
    ]);
    expect(DesignSchema.safeParse(r.next).success).toBe(true);
    expect(r.next!.meta.createdAt).toBe(NOW);
  });
});
