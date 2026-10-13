// 视口变换与吸附（方案 11.2 节）。纯逻辑，不碰 React 和浏览器。
// 视口：屏幕坐标 = 世界坐标(毫米) × scale + (tx, ty)。缩放平移只改视口，不改数据。
export interface Viewport { tx: number; ty: number; scale: number } // scale = 每毫米多少像素
export interface Point { x: number; y: number }

export const MIN_SCALE = 0.004; // 整层楼都看得下
export const MAX_SCALE = 1.2; // 看清单个构件

export const worldToScreen = (v: Viewport, p: Point): Point => ({ x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty });
export const screenToWorld = (v: Viewport, p: Point): Point => ({ x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale });

/** 以屏幕点 s 为中心缩放 factor 倍 */
export function zoomAt(v: Viewport, s: Point, factor: number): Viewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = scale / v.scale;
  return { scale, tx: s.x - (s.x - v.tx) * k, ty: s.y - (s.y - v.ty) * k };
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

/** 让世界范围居中占满画布（留边距）。没有内容时给一个默认视口。 */
export function fitViewport(bounds: Bounds | null, size: { w: number; h: number }, pad = 90): Viewport {
  if (!bounds || bounds.x1 - bounds.x0 < 1 || !size.w || !size.h) {
    return { scale: 0.04, tx: size.w / 2, ty: size.h / 2 };
  }
  const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh)));
  return {
    scale,
    tx: (size.w - (bounds.x0 + bounds.x1) * scale) / 2,
    ty: (size.h - (bounds.y0 + bounds.y1) * scale) / 2,
  };
}

/** 当前能看到的世界范围 */
export function visibleWorld(v: Viewport, size: { w: number; h: number }): Bounds {
  const a = screenToWorld(v, { x: 0, y: 0 }), b = screenToWorld(v, { x: size.w, y: size.h });
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** 网格线间距：用户选的步长在缩得太小时自动放大倍数，保证线与线至少隔 8 像素 */
export function displayGridStep(userStep: number, scale: number): number {
  for (const k of [1, 5, 10, 50, 500]) {
    const step = userStep * k;
    if (step * scale >= 8) return step;
  }
  return userStep * 500;
}

// ---------- 吸附（方案 11.2：网格 + 其他房间边 8 像素内对齐，按 Alt 关闭） ----------

export interface AxisSnap { value: number; guide?: number } // guide：对齐参考线所在的世界坐标

/**
 * 单轴吸附。raw：没吸附时的坐标；span：吸附对象沿这个轴的长度（吸附“边”时传 0）；
 * otherEdges：可以对齐到的目标边坐标；tol：吸附范围（世界毫米，一般由 8 像素换算）。
 */
export function snapAxis(raw: number, span: number, otherEdges: number[], gridStep: number, tol: number, on: boolean): AxisSnap {
  if (!on) return { value: raw };
  let best: AxisSnap | undefined;
  let bestD = Infinity;
  for (const e of otherEdges) {
    for (const mine of [raw, raw + span]) {
      const value = raw + (e - mine);
      const d = Math.abs(value - raw);
      if (d <= tol && d < bestD) { bestD = d; best = { value, guide: e }; }
    }
  }
  if (best) return best;
  return { value: Math.round(raw / gridStep) * gridStep };
}

/** 8 像素的吸附范围换算成世界毫米 */
export const snapTol = (scale: number): number => 8 / scale;

// ---------- 平面绘制要用的几何 ----------

/** 墙段画成矩形：沿墙方向为长，垂直方向为厚（真实厚度） */
export function wallRect(seg: { orientation: 'h' | 'v'; line: number; start: number; end: number; thickness: number }) {
  return seg.orientation === 'h'
    ? { x: seg.start, y: seg.line - seg.thickness / 2, w: seg.end - seg.start, h: seg.thickness }
    : { x: seg.line - seg.thickness / 2, y: seg.start, w: seg.thickness, h: seg.end - seg.start };
}

export interface OpeningGeom {
  orientation: 'h' | 'v';
  line: number; start: number; end: number;   // 洞口区间（沿墙方向）
  t: number;                                  // 墙厚
  hostSign: 1 | -1;                           // 垂直墙方向上，持有房间在 + 方向（h 的下方 / v 的右侧）为 1
  x0: number; y0: number; x1: number; y1: number; // 洞口矩形（世界坐标）
}

/** 门/窗在墙上的绘制几何（几何层 openingSpan 只给区间，这里补齐墙厚、方向和矩形） */
export function openingGeom(o: { offset: number; width: number }, edge: { orientation: 'h' | 'v'; line: number; start: number; end: number; plusSide: boolean }, thickness: number): OpeningGeom {
  const hostSign: 1 | -1 = edge.plusSide ? 1 : -1;
  const start = edge.start + o.offset, end = start + o.width;
  return edge.orientation === 'h'
    ? { orientation: 'h', line: edge.line, start, end, t: thickness, hostSign, x0: start, y0: edge.line - thickness / 2, x1: end, y1: edge.line + thickness / 2 }
    : { orientation: 'v', line: edge.line, start, end, t: thickness, hostSign, x0: edge.line - thickness / 2, y0: start, x1: edge.line + thickness / 2, y1: end };
}

/** 圆弧的 SVG sweep 标记：用起点、圆心、终点的叉积判断方向，与坐标系翻转无关 */
export function arcSweep(cx: number, cy: number, sx: number, sy: number, ex: number, ey: number): 0 | 1 {
  return (sx - cx) * (ey - cy) - (sy - cy) * (ex - cx) > 0 ? 1 : 0;
}

/**
 * 平开门符号：门扇线（从铰链垂直于墙伸出，长 = 门宽）+ 四分之一开启弧线。
 * 返回 SVG path。sideSign：门扇开向哪一侧（+1 为 h 墙下方 / v 墙右侧）。
 */
export function swingDoorPath(g: OpeningGeom, hinge: 'start' | 'end', sideSign: 1 | -1): string {
  const w = g.end - g.start; // 门宽即半径
  const hx = g.orientation === 'h' ? (hinge === 'start' ? g.start : g.end) : g.line;
  const hy = g.orientation === 'h' ? g.line : (hinge === 'start' ? g.start : g.end);
  const perp: Point = g.orientation === 'h' ? { x: 0, y: sideSign } : { x: sideSign, y: 0 };
  const tip = { x: hx + perp.x * w, y: hy + perp.y * w };
  const ox = g.orientation === 'h' ? (hinge === 'start' ? g.end : g.start) : g.line;
  const oy = g.orientation === 'h' ? g.line : (hinge === 'start' ? g.end : g.start);
  const sweep = arcSweep(hx, hy, tip.x, tip.y, ox, oy);
  return `M ${hx} ${hy} L ${tip.x} ${tip.y} A ${w} ${w} 0 0 ${sweep} ${ox} ${oy} Z`;
}

// ---------- 其他小工具 ----------

/** 新房间的默认名：房间1、房间2…取最小的未占用编号 */
export function autoRoomName(existing: readonly { name: string }[]): string {
  const used = new Set(existing.map((r) => r.name));
  for (let n = 1; n <= existing.length + 99; n++) if (!used.has(`房间${n}`)) return `房间${n}`;
  return `房间${existing.length + 100}`;
}

/** 世界坐标落在哪个房间里（后画的在上；正常设计里不会重叠） */
export function roomAt(rooms: readonly { id: string; x: number; y: number; length: number; width: number }[], p: Point): string | undefined {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const r = rooms[i]!;
    if (p.x >= r.x && p.x <= r.x + r.length && p.y >= r.y && p.y <= r.y + r.width) return r.id;
  }
  return undefined;
}

/** 毫米数显示成米：5230 → “5.23 m” */
export const meters = (mm: number): string => `${(mm / 1000).toFixed(2)} m`;
