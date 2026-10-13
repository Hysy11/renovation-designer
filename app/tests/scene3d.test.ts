// 场景描述纯函数测试（方案 12.1、12.2、12.3）
import { describe, expect, it } from 'vitest';
import { cutWallBoxes, describeScene } from '../src/scene3d/describe';
import { buildFurniture } from '../src/scene3d/builders';
import { design, door, furn, room, twoRooms, windowOf } from './fixtures';

describe('墙切块 cutWallBoxes', () => {
  it('无洞口：一整块', () => {
    expect(cutWallBoxes(0, 5000, 2800, [])).toEqual([{ from: 0, to: 5000, y0: 0, y1: 2800, kind: 'wall' }]);
  });

  it('门洞：两侧墙块 + 上方过梁', () => {
    const b = cutWallBoxes(0, 5000, 2800, [{ start: 1000, end: 1900, sill: 0, top: 2100 }]);
    expect(b).toEqual([
      { from: 0, to: 1000, y0: 0, y1: 2800, kind: 'wall' },
      { from: 1000, to: 1900, y0: 2100, y1: 2800, kind: 'lintel' },
      { from: 1900, to: 5000, y0: 0, y1: 2800, kind: 'wall' },
    ]);
  });

  it('窗洞：下方窗台 + 上方过梁', () => {
    const b = cutWallBoxes(0, 5000, 2800, [{ start: 1000, end: 2500, sill: 900, top: 2400 }]);
    expect(b).toEqual([
      { from: 0, to: 1000, y0: 0, y1: 2800, kind: 'wall' },
      { from: 1000, to: 2500, y0: 0, y1: 900, kind: 'sill' },
      { from: 1000, to: 2500, y0: 2400, y1: 2800, kind: 'lintel' },
      { from: 2500, to: 5000, y0: 0, y1: 2800, kind: 'wall' },
    ]);
  });

  it('剖切（cutHeight 1000）：高于剖切线的部分全部消失', () => {
    const b = cutWallBoxes(0, 5000, 2800, [{ start: 1000, end: 1900, sill: 0, top: 2100 }], 1000);
    expect(b).toEqual([
      { from: 0, to: 1000, y0: 0, y1: 1000, kind: 'wall' },
      { from: 1900, to: 5000, y0: 0, y1: 1000, kind: 'wall' },
    ]);
  });

  it('两个洞口从左到右处理', () => {
    const b = cutWallBoxes(0, 6000, 2800, [
      { start: 3000, end: 4500, sill: 900, top: 2400 },
      { start: 1000, end: 1900, sill: 0, top: 2100 },
    ]);
    expect(b.map((x) => `${x.from}-${x.to}@${x.y0}-${x.y1}:${x.kind}`)).toEqual([
      '0-1000@0-2800:wall',
      '1000-1900@2100-2800:lintel',
      '1900-3000@0-2800:wall',
      '3000-4500@0-900:sill',
      '3000-4500@2400-2800:lintel',
      '4500-6000@0-2800:wall',
    ]);
  });
});

describe('家具造型', () => {
  it('双人床：床架、床垫、床头板三部件；米单位', () => {
    const s = buildFurniture({ templateId: 'bed.double', l: 1800, w: 2000, h: 450 });
    expect(s.map((p) => p.partId).sort()).toEqual(['bedding', 'frame', 'headboard']);
    expect(s[0]!.size).toEqual([1.8, 0.22, 2.0]);
  });

  it('每类模板都有造型且部件在模板清单里', () => {
    const ids = ['bed.double', 'wardrobe.basic', 'sofa.3seat', 'table.coffee', 'cabinet.tv', 'table.dining', 'chair.dining', 'desk.basic', 'kitchen.base', 'rug.basic'];
    for (const id of ids) {
      const s = buildFurniture({ templateId: id, l: 1000, w: 800, h: 700 });
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('未知模板兜底成一块盒子，不缺对象', () => {
    const s = buildFurniture({ templateId: 'nope', l: 1000, w: 800, h: 700 });
    expect(s).toHaveLength(1);
  });
});

describe('describeScene 全屋', () => {
  it('单房间：地板 + 四面墙 + 基座；取景数据合理', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000)] });
    const spec = describeScene(d);
    const floors = spec.parts.filter((p) => p.kind === 'floor');
    const walls = spec.parts.filter((p) => p.kind === 'wall');
    const base = spec.parts.filter((p) => p.kind === 'base');
    expect(floors).toHaveLength(1);
    expect(floors[0]!.pos).toEqual([2.5, -0.015, 2]);
    expect(floors[0]!.size).toEqual([5, 0.03, 4]);
    expect(walls).toHaveLength(4); // 四面外墙各一整块
    expect(base).toHaveLength(1);
    // 基座 = 外轮廓(含外墙厚) + 600 边距：(5+0.24+1.2) = 6.44
    expect(base[0]!.size[0]).toBeCloseTo(6.44, 6);
    expect(base[0]!.size[2]).toBeCloseTo(5.44, 6);
    expect(base[0]!.pos[1]).toBeCloseTo(-0.03 - 0.225, 6); // 顶面贴地板底
    expect(spec.center).toEqual([2.5, 2]);
    expect(spec.extent).toBeCloseTo(6.44 / 2, 6);
  });

  it('墙上有门：门洞两侧墙块 + 过梁 + 门框门扇；洞口在 z 上重合', () => {
    const d = twoRooms();
    d.openings.push(door('o_1', 'r_a', 'right', 1000));
    const spec = describeScene(d);
    const seg = spec.parts.filter((p) => p.kind === 'wall' && Math.abs(p.pos[0] - 5) < 0.01);
    // 共用墙被门洞切成两块墙 + 一块过梁
    expect(seg.length).toBe(3);
    const lintel = seg.filter((p) => p.pos[1] > 2);   // 过梁中心 2.45 m，整墙块中心 1.4 m
    expect(lintel).toHaveLength(1);
    // 门框 3 条（无旋转的开口部件）+ 门扇 1 扇（带 rotY）
    const doorParts = spec.parts.filter((p) => p.kind === 'opening' && p.ref?.id === 'o_1');
    expect(doorParts.filter((p) => p.rotY === undefined)).toHaveLength(3);
    expect(doorParts.filter((p) => p.rotY !== undefined)).toHaveLength(1);
    expect(doorParts.some((p) => p.rotY !== undefined)).toBe(true); // 平开门微开
  });

  it('共用墙两侧颜色不同（WALL-03）', () => {
    const d = twoRooms();
    d.rooms[0]!.wallColors = { right: '#123456' };
    const spec = describeScene(d);
    const shared = spec.parts.find((p) => p.kind === 'wall' && Math.abs(p.pos[0] - 5) < 0.01)!;
    // plus 面（+x，朝卧室）、minus 面（-x，朝客厅）；客厅单独设了色
    expect(shared.color).toBe('#F3ECE0');
    expect(shared.colorB).toBe('#123456');
    expect(shared.faceAxis).toBe('x');
  });

  it('家具：cx/cy 是绝对画布坐标——房间不在原点时不叠加房间位置（回归）', () => {
    const d = design({
      rooms: [room('r_a', 5000, 2000, 4000, 3000)],
      furniture: [furn('f_1', 'r_a', 'bed.double', 7000, 3500, 1800, 2000, { h: 450 })],
    });
    const bed = describeScene(d).parts.find((p) => p.kind === 'furniture' && p.size[1] < 0.5)!;
    expect(bed.pos[0]).toBeCloseTo(7.0, 6);   // 不是 5000+7000=12 m
    expect(bed.pos[2]).toBeCloseTo(3.5, 6);
  });

  it('家具：旋转 90° 交换分量', () => {
    const d = twoRooms();
    d.furniture.push(furn('f_1', 'r_a', 'bed.double', 2500, 1000, 1800, 2000, { h: 450 }));
    const flat = describeScene(d).parts.filter((p) => p.kind === 'furniture' && p.ref?.id === 'f_1');
    expect(flat.length).toBeGreaterThan(0);
    const bed = flat.find((p) => p.size[1] < 0.5)!; // 床架块
    expect(bed.pos[0]).toBeCloseTo(2.5, 6);
    expect(bed.pos[2]).toBeCloseTo(1.0, 6);
    const rot = describeScene(design({
      rooms: [room('r_a', 0, 0, 5000, 4000)],
      furniture: [furn('f_1', 'r_a', 'bed.double', 2500, 1000, 1800, 2000, { h: 450, rotation: 90 })],
    })).parts.filter((p) => p.kind === 'furniture');
    const bedR = rot.find((p) => p.size[1] < 0.5)!;
    // 旋转 90°：局部 (x,z)→(z,-x)，床架中心在原点不变，但部件朝向字段 rotY 生效
    expect(bedR.rotY).toBe(-90);
  });

  it('开放墙不生成墙块（WALL-04），地面相接', () => {
    const d = twoRooms();
    d.walls['shared:r_a|r_b'] = { open: true };
    const spec = describeScene(d);
    expect(spec.parts.some((p) => p.kind === 'wall' && Math.abs(p.pos[0] - 5) < 0.01)).toBe(false);
  });

  it('空设计：无基座、默认取景', () => {
    const spec = describeScene(design());
    expect(spec.parts.filter((p) => p.kind !== 'base')).toHaveLength(0);
    expect(spec.center).toEqual([0, 0]);
    expect(spec.extent).toBe(6);
  });
});

describe('describeScene 剖面与单间（方案 12.2、12.3）', () => {
  it('剖切墙降到 1000，门洞上方过梁消失；未剖的墙维持原高', () => {
    const d = twoRooms();
    d.openings.push(door('o_1', 'r_a', 'right', 1000));
    const derived = { cutWallKeys: new Set(['shared:r_a|r_b@0']) };
    const spec = describeScene(d, derived);
    const shared = spec.parts.filter((p) => p.kind === 'wall' && Math.abs(p.pos[0] - 5) < 0.01);
    expect(shared.every((p) => p.pos[1] + p.size[1] / 2 <= 1.0)).toBe(true); // 顶不高于 1m
    const doorParts = spec.parts.filter((p) => p.kind === 'opening' && p.ref?.id === 'o_1');
    expect(doorParts).toHaveLength(0); // 门整体高于剖切线：不显示
    const top = spec.parts.filter((p) => p.kind === 'wall' && p.pos[1] + p.size[1] / 2 > 1.001);
    expect(top.length).toBeGreaterThan(0); // 其他墙仍 2.8m
  });

  it('单间视图：只显示本间的地板、墙和家具；共用墙另一面用中性色', () => {
    const d = twoRooms();
    d.furniture.push(furn('f_a', 'r_a', 'sofa.3seat', 2500, 3000, 2200, 900, { h: 800 }));
    d.furniture.push(furn('f_b', 'r_b', 'bed.double', 1750, 1000, 1800, 2000, { h: 450 }));
    const spec = describeScene(d, { scope: { roomId: 'r_a' } });
    expect(spec.parts.filter((p) => p.kind === 'floor')).toHaveLength(1);
    expect(spec.parts.filter((p) => p.kind === 'furniture').every((p) => p.ref!.id === 'f_a')).toBe(true);
    // 展台 margin 300：外轮廓 5×4 + 外墙厚 240 + 边距 600 → 5.84 × 4.84（米）
    const base = spec.parts.find((p) => p.kind === 'base')!;
    expect(base.size[0]).toBeCloseTo(5.84, 6);
    expect(base.size[2]).toBeCloseTo(4.84, 6);
    // 共用墙：朝客厅的一面（minus，-x）是本色，朝卧室的一面（plus）中性
    const shared = spec.parts.find((p) => p.kind === 'wall' && Math.abs(p.pos[0] - 5) < 0.01)!;
    expect(shared.color).toBe('#E8E4DA');
    expect(shared.colorB).toBe('#F3ECE0');
  });

  it('窗口玻璃与窗框都生成', () => {
    const d = design({ rooms: [room('r_a', 0, 0, 5000, 4000)], openings: [windowOf('w_1', 'r_a', 'top', 1000)] });
    const spec = describeScene(d);
    const w = spec.parts.filter((p) => p.kind === 'opening' && p.ref?.id === 'w_1');
    expect(w.filter((p) => p.material === 'glass')).toHaveLength(1);
    expect(w.filter((p) => p.material !== 'glass').length).toBe(4); // 四条框
  });
});
