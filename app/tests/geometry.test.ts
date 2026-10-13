import { describe, expect, it } from 'vitest';
import { deriveWalls, interiorRect, netSize, neighbours } from '../src/geometry/walls';
import { validateDesign, furnitureCorners } from '../src/geometry/validate';
import { design, door, furn, room, twoRooms, windowOf } from './fixtures';

const ids = (d: ReturnType<typeof design>) => deriveWalls(d).segments.map((s) => `${s.id}[${s.start},${s.end}]`).sort();
const errors = (d: ReturnType<typeof design>) => validateDesign(d).filter((i) => i.level === 'error').map((i) => i.code);
const warnings = (d: ReturnType<typeof design>) => validateDesign(d).filter((i) => i.level === 'warning').map((i) => i.code);

describe('墙段推导', () => {
  it('单个房间：四面外墙，默认厚 240', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000)] });
    const w = deriveWalls(d);
    expect(ids(d)).toEqual(['ext:r_a:bottom[0,5000]', 'ext:r_a:left[0,4000]', 'ext:r_a:right[0,4000]', 'ext:r_a:top[0,5000]']);
    expect(w.segments.every((s) => s.kind === 'exterior' && s.thickness === 240 && s.height === 2800)).toBe(true);
  });

  it('净尺寸：5000×4000、四周 240 → 4760×3760（方案第 5 节例子）', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000)] });
    expect(netSize(d.rooms[0]!, deriveWalls(d))).toEqual({ length: 4760, width: 3760 });
  });

  it('两间完全相邻：一段共用墙，厚 120', () => {
    const d = twoRooms();
    const w = deriveWalls(d);
    const shared = w.segments.filter((s) => s.kind === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ id: 'shared:r_a|r_b', line: 5000, start: 0, end: 4000, thickness: 120 });
    expect(shared[0]!.minus).toEqual({ roomId: 'r_a', side: 'right' });
    expect(shared[0]!.plus).toEqual({ roomId: 'r_b', side: 'left' });
    expect(netSize(d.rooms[0]!, w)).toEqual({ length: 5000 - 120 - 60, width: 3760 });
    expect(neighbours('r_a', w)).toEqual(['r_b']);
  });

  it('部分相邻：一条边切成共用墙 + 外墙，外墙部分同一编号', () => {
    // 客厅 0..5000 × 0..4000；卧室在右侧 y 1000..3000
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000), room('r_b', 5000, 1000, 3000, 2000)] });
    const segs = deriveWalls(d).segments.filter((s) => s.orientation === 'v' && s.line === 5000);
    expect(segs.map((s) => `${s.key}:${s.end}`)).toEqual([
      'ext:r_a:right@0:1000', 'shared:r_a|r_b@1000:3000', 'ext:r_a:right@3000:4000',
    ]);
    // 右边有 240 外墙段，取最厚
    expect(interiorRect(d.rooms[0]!, deriveWalls(d)).x1).toBe(5000 - 120);
  });

  it('T 形交接：下方两间房共用上方大房间的下边', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 8000, 4000), room('r_b', 0, 4000, 4000, 3000), room('r_c', 4000, 4000, 4000, 3000)] });
    const segs = deriveWalls(d).segments.filter((s) => s.orientation === 'h' && s.line === 4000);
    expect(segs.map((s) => s.id)).toEqual(['shared:r_a|r_b', 'shared:r_a|r_c']);
    expect(deriveWalls(d).segments.filter((s) => s.id === 'shared:r_b|r_c')).toHaveLength(1);
  });

  it('开放边：不扣墙厚，门窗不能放在上面', () => {
    const d = twoRooms();
    d.walls['shared:r_a|r_b'] = { open: true };
    const w = deriveWalls(d);
    expect(netSize(d.rooms[0]!, w).length).toBe(5000 - 120);
    d.openings.push(door('o_1', 'r_a', 'right', 1000));
    expect(errors(d)).toContain('OPENING_ON_OPEN_WALL');
  });

  it('改过的墙属性生效，失效的记录被检查出来', () => {
    const d = twoRooms();
    d.walls['shared:r_a|r_b'] = { thickness: 200 };
    expect(deriveWalls(d).byId.get('shared:r_a|r_b')![0]!.thickness).toBe(200);
    d.walls['shared:r_a|r_x'] = { thickness: 200 };
    expect(errors(d)).toEqual(['WALL_UNKNOWN']);
  });
});

describe('房间检查', () => {
  it('合法设计没有错误', () => expect(validateDesign(twoRooms())).toEqual([]));
  it('重叠报错，共边不算', () => {
    const d = twoRooms();
    d.rooms[1]!.x = 4900;
    expect(errors(d)).toContain('ROOM_OVERLAP');
  });
  it('尺寸范围', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 400, 4000)] });
    expect(errors(d)).toEqual(['ROOM_SIZE']);
  });
});

describe('门窗检查', () => {
  it('完整落在墙段内通过', () => {
    const d = twoRooms();
    d.openings.push(door('o_1', 'r_a', 'right', 1000), windowOf('o_2', 'r_a', 'top', 1000));
    expect(validateDesign(d)).toEqual([]);
  });

  it('伸出墙端：给出差多少和建议', () => {
    const d = twoRooms();
    d.openings.push(door('o_1', 'r_a', 'right', 3250)); // 3250+900=4150 > 4000
    const e = validateDesign(d).find((i) => i.code === 'OPENING_OUT_OF_WALL')!;
    expect(e.message).toContain('150 mm');
    expect(e.hint).toBe('可以把位置减小到 3100 mm 以内，或把门宽改为 750 mm 以下');
  });

  it('跨过外墙与共用墙的分界报错', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000), room('r_b', 5000, 1000, 3000, 2000)] });
    d.openings.push(door('o_1', 'r_a', 'right', 2500)); // 2500..3400 跨过 3000
    const e = validateDesign(d).find((i) => i.code === 'OPENING_OUT_OF_WALL')!;
    expect(e.message).toContain('分界');
  });

  it('同一直线上不同房间持有的洞口重叠', () => {
    const d = twoRooms();
    d.openings.push(door('o_1', 'r_a', 'right', 1000), door('o_2', 'r_b', 'left', 1500));
    expect(errors(d)).toEqual(['OPENING_OVERLAP']);
  });

  it('高于墙、入户门在共用墙、室内门在外墙', () => {
    const d = twoRooms();
    d.openings.push(windowOf('o_1', 'r_a', 'top', 500));
    d.openings[0]!.height = 2000; // 900+2000 > 2800
    d.openings.push(door('o_2', 'r_a', 'right', 500, 900, { use: 'entry' }));
    d.openings.push(door('o_3', 'r_a', 'bottom', 500));
    expect(errors(d).sort()).toEqual(['ENTRY_DOOR_NOT_EXTERIOR', 'OPENING_TOO_TALL']);
    expect(warnings(d)).toEqual(['INTERIOR_DOOR_ON_EXTERIOR']);
  });

  it('不适用的字段被拒绝', () => {
    const d = twoRooms();
    d.openings.push(door('o_1', 'r_a', 'right', 500, 900, { openMode: 'none' })); // 仍带 hinge、swingInto
    d.openings.push({ ...windowOf('o_2', 'r_a', 'top', 500), use: 'interior' });
    const e = validateDesign(d).filter((i) => i.code === 'OPENING_FIELD_NA').map((i) => `${i.target.id}.${i.field}`);
    expect(e.sort()).toEqual(['o_1.hinge', 'o_1.swingInto', 'o_2.use']);
  });
});

describe('家具检查', () => {
  it('四个角：旋转 90° 后长宽互换', () => {
    const c = furnitureCorners({ cx: 0, cy: 0, l: 2000, w: 1000, rotation: 90 });
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2000);
  });

  it('不旋转放得下，旋转 90° 后穿墙', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 3000)] });
    d.furniture.push(furn('f_1', 'r_a', 'sofa.3seat', 2500, 2000, 3000, 900));
    expect(validateDesign(d)).toEqual([]);
    d.furniture[0]!.rotation = 90;
    expect(errors(d)).toEqual(['FURN_OUT_OF_ROOM']);
  });

  it('旋转 45° 的角越界也能发现', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 3000, 3000)] });
    d.furniture.push(furn('f_1', 'r_a', 'table.coffee', 1500, 1500, 1800, 1000, { rotation: 45, h: 420 }));
    expect(validateDesign(d)).toEqual([]);
    d.furniture[0]!.cx = 2000;
    expect(errors(d)).toEqual(['FURN_OUT_OF_ROOM']);
  });

  it('开放边不扣墙厚，但不能横跨到相邻房间', () => {
    const d = twoRooms();
    d.walls['shared:r_a|r_b'] = { open: true };
    d.furniture.push(furn('f_1', 'r_a', 'table.coffee', 5000 - 600, 2000, 1200, 600, { h: 420 })); // 右缘正好在 5000
    expect(validateDesign(d)).toEqual([]);
    d.furniture[0]!.cx += 10;
    expect(errors(d)).toEqual(['FURN_OUT_OF_ROOM']);
  });

  it('尺寸与材质超出模板：该家具不支持', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000)] });
    d.furniture.push(furn('f_1', 'r_a', 'sofa.3seat', 2500, 2000, 4000, 900, { appearance: { legs: { material: 'glass' } } }));
    const e = validateDesign(d).filter((i) => i.level === 'error');
    expect(e.map((i) => i.code).sort()).toEqual(['FURN_MATERIAL', 'FURN_SIZE']);
    expect(e.every((i) => i.message.startsWith('该家具不支持'))).toBe(true);
  });

  it('家具重叠只提示；地毯可叠放不提示', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000)] });
    d.furniture.push(furn('f_1', 'r_a', 'table.dining', 2500, 2000, 1400, 800), furn('f_2', 'r_a', 'chair.dining', 2500, 2400, 450, 500));
    expect(errors(d)).toEqual([]);
    expect(warnings(d)).toEqual(['FURN_OVERLAP']);
    d.furniture[1] = furn('f_2', 'r_a', 'rug.basic', 2500, 2000, 2000, 1400, { h: 10 });
    expect(validateDesign(d)).toEqual([]);
  });

  it('只碰边不算重叠', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000)] });
    d.furniture.push(furn('f_1', 'r_a', 'desk.basic', 1000, 1000, 1200, 600), furn('f_2', 'r_a', 'desk.basic', 2200, 1000, 1200, 600));
    expect(validateDesign(d)).toEqual([]);
  });
});

describe('家具越界检查的坐标系', () => {
  it('房间不在原点时，家具越界检查仍然正确（回归：绝对 vs 相对坐标）', () => {
    const base = design({ rooms: [room('r_x', 5000, 2000, 5000, 4000)] });
    const inside = validateDesign({ ...base, furniture: [furn('f_1', 'r_x', 'sofa.3seat', 7500, 4000, 2200, 900)] });
    expect(inside.filter((i) => i.level === 'error')).toHaveLength(0);
    const bad = validateDesign({ ...base, furniture: [furn('f_1', 'r_x', 'sofa.3seat', 7500, 5500, 2200, 900)] });
    expect(bad.find((i) => i.code === 'FURN_OUT_OF_ROOM')?.message).toContain('下侧超出');
  });
});
