// 平面页纯逻辑的测试（方案第 14 节没有单列，这里覆盖视口、吸附、绘制几何）。
import { describe, expect, it } from 'vitest';
import {
  arcSweep, autoRoomName, displayGridStep, fitViewport, meters, openingGeom,
  roomAt, snapAxis, snapTol, swingDoorPath, visibleWorld, wallRect, worldToScreen, screenToWorld, zoomAt,
} from '../src/plan/transform';

describe('视口变换', () => {
  const v = { tx: 100, ty: 50, scale: 0.02 };

  it('世界与屏幕来回换算一致', () => {
    const p = { x: 5000, y: 3000 };
    const s = worldToScreen(v, p);
    expect(s).toEqual({ x: 200, y: 110 });
    expect(screenToWorld(v, s)).toEqual(p);
  });

  it('以鼠标为中心缩放：鼠标位置的世界点不动', () => {
    const at = { x: 300, y: 200 };
    const before = screenToWorld(v, at);
    const after = screenToWorld(zoomAt(v, at, 1.25), at);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);
  });

  it('缩放有上下限', () => {
    expect(zoomAt(v, { x: 0, y: 0 }, 1e-9).scale).toBe(0.004);
    expect(zoomAt(v, { x: 0, y: 0 }, 1e9).scale).toBe(1.2);
  });

  it('适合窗口：给定范围居中，大小撑到留边', () => {
    const f = fitViewport({ x0: 0, y0: 0, x1: 8000, y1: 6000 }, { w: 1000, h: 800 });
    expect(f.scale).toBeCloseTo(0.1); // (1000-180)/8000
    const a = worldToScreen(f, { x: 0, y: 0 }), b = worldToScreen(f, { x: 8000, y: 6000 });
    expect((a.x + b.x) / 2).toBeCloseTo(500);
    expect((a.y + b.y) / 2).toBeCloseTo(400);
  });

  it('没有内容时给默认视口；能反推可见范围', () => {
    const f = fitViewport(null, { w: 800, h: 600 });
    expect(visibleWorld(f, { w: 800, h: 600 })).toBeDefined();
    expect(fitViewport(null, { w: 0, h: 0 }).scale).toBeGreaterThan(0);
  });

  it('网格步长随缩放自动放粗', () => {
    expect(displayGridStep(100, 0.1)).toBe(100);  // 10 像素
    expect(displayGridStep(100, 0.05)).toBe(500); // 100→5px 不够，放大到 500→25px
    expect(displayGridStep(50, 0.004)).toBe(2500);
  });
});

describe('吸附', () => {
  it('网格吸附到步长倍数', () => {
    expect(snapAxis(1030, 0, [], 100, 100, true)).toEqual({ value: 1000 });
    expect(snapAxis(1080, 0, [], 100, 100, true)).toEqual({ value: 1100 });
  });

  it('移动矩形时：自己的任何一条边都能贴到目标边', () => {
    // 房间左边在 1030，宽 3000（右边 4030）；目标边 4400 距右边 370mm，在容差 400 内
    const r = snapAxis(1030, 3000, [4400], 100, 400, true);
    expect(r.value).toBe(1400); // 右边 4430 → 贴到 4400
    expect(r.guide).toBe(4400);
  });

  it('目标边太远时落回网格', () => {
    expect(snapAxis(1030, 3000, [9000], 100, 100, true)).toEqual({ value: 1000 });
  });

  it('Alt 关闭吸附时原样返回', () => {
    expect(snapAxis(1030, 0, [1040], 100, 100, false)).toEqual({ value: 1030 });
  });

  it('8 像素容差随缩放换算', () => {
    expect(snapTol(0.02)).toBe(400);
    expect(snapTol(0.08)).toBe(100);
  });
});

describe('绘制几何', () => {
  it('墙段矩形：横墙沿 x、竖墙沿 y，厚度以中心线对称', () => {
    expect(wallRect({ orientation: 'h', line: 4000, start: 0, end: 5000, thickness: 240 }))
      .toEqual({ x: 0, y: 3880, w: 5000, h: 240 });
    expect(wallRect({ orientation: 'v', line: 5000, start: 0, end: 4000, thickness: 120 }))
      .toEqual({ x: 4940, y: 0, w: 120, h: 4000 });
  });

  it('门窗洞口矩形与持有方向', () => {
    // 客厅右墙（x=5000），持有房间在左侧 → hostSign = -1
    const g = openingGeom({ offset: 1000, width: 900 }, { orientation: 'v', line: 5000, start: 0, end: 4000, plusSide: false }, 240);
    expect(g).toMatchObject({ orientation: 'v', start: 1000, end: 1900, t: 240, hostSign: -1, x0: 4880, y0: 1000, x1: 5120, y1: 1900 });
    // 客厅上墙（y=0），持有房间在下方 → hostSign = 1
    const h = openingGeom({ offset: 1500, width: 1500 }, { orientation: 'h', line: 0, start: 0, end: 5000, plusSide: true }, 240);
    expect(h).toMatchObject({ hostSign: 1, x0: 1500, y0: -120, x1: 3000, y1: 120 });
  });

  it('弧线方向标记与坐标系无关', () => {
    expect(arcSweep(0, 0, 0, 1, 1, 0)).toBe(0); // 屏幕坐标里逆时针
    expect(arcSweep(0, 0, 1, 0, 0, 1)).toBe(1);
  });

  it('平开门路径包含门扇线、弧线并闭合到铰链', () => {
    const g = openingGeom({ offset: 0, width: 900 }, { orientation: 'h', line: 0, start: 0, end: 5000, plusSide: true }, 240);
    const d = swingDoorPath(g, 'start', 1);
    // 铰链 (0,0)，门扇尖 (0,900)，扫到 (900,0)
    expect(d).toContain('M 0 0 L 0 900 A 900 900 0 0');
    expect(d.trim().endsWith('Z')).toBe(true);
    // 铰链换到末端：起点是 (900,0)
    expect(swingDoorPath(g, 'end', 1)).toContain('M 900 0');
  });
});

describe('小工具', () => {
  it('自动房间名跳过已占用', () => {
    expect(autoRoomName([{ name: '房间1' }, { name: '房间2' }])).toBe('房间3');
    expect(autoRoomName([{ name: '房间2' }, { name: '房间3' }])).toBe('房间1');
  });

  it('roomAt 命中包含点的房间', () => {
    const rooms = [{ id: 'a', x: 0, y: 0, length: 5000, width: 4000 }, { id: 'b', x: 5000, y: 0, length: 3000, width: 4000 }];
    expect(roomAt(rooms, { x: 2500, y: 2000 })).toBe('a');
    expect(roomAt(rooms, { x: 6000, y: 2000 })).toBe('b');
    expect(roomAt(rooms, { x: 9000, y: 2000 })).toBeUndefined();
  });

  it('毫米转米显示', () => {
    expect(meters(5230)).toBe('5.23 m');
    expect(meters(4000)).toBe('4.00 m');
  });
});
