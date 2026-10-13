// 场景总装（方案 12.1、12.2）：把“显示用设计”变成场景描述的纯函数。
// 只输出数据（米）：同一份设计必然得到同一份描述；把它变成 three.js 网格是 SceneView 的事。
// 坐标口径（方案第 5 节）：平面 x → 3D X，平面 y → 3D Z，高度 → Y，地面 Y = 0，1 单位 = 1 米。
import type { Design, MaterialId, FloorMaterialId, Opening, Side } from '../model/schema';
import { deriveWalls, findHostSegment, openingSpan, type WallSegment } from '../geometry/walls';
import { exteriorFaceColor, furniturePart, openingColors, roomFloor, wallColor } from '../engine/appearance';
import { buildFurniture } from './builders';

export interface ScenePart {
  pos: [number, number, number];      // 盒子中心（米，世界坐标）
  size: [number, number, number];     // 盒子长宽高（米）
  rotY?: number;                      // 绕 Y 轴旋转（度）
  radius?: number;                    // 圆角半径（米）
  color: string;
  colorB?: string;                    // 墙块另一面的颜色（WALL-03 两侧不同色）
  faceAxis?: 'x' | 'z';               // 双色面的法向轴：h 墙是 z，v 墙是 x
  material: MaterialId | FloorMaterialId;
  kind: 'floor' | 'wall' | 'opening' | 'furniture' | 'base';
  ref?: { kind: 'room' | 'wall' | 'opening' | 'furniture'; id: string };  // 点选时映射回选中对象
}

export interface SceneSpec {
  parts: ScenePart[];
  /** 自动取景中心（XZ，米）与半径（米） */
  center: [number, number];
  extent: number;
}

export interface DescribeOpts {
  /** 全屋视图（默认）或单间视图（方案 12.2） */
  scope?: 'house' | { roomId: string };
  /** 剖面（方案 12.3）：这些墙 key 降到 cutHeight；高于剖切线的门窗不显示 */
  cutWallKeys?: ReadonlySet<string>;
  /** 剖面墙高（毫米），默认 1000 */
  cutHeight?: number;
}

const NEUTRAL = '#E8E4DA'; // 单间视图中共用墙背面的中性色（方案 12.2）

// ---------- 墙切块（方案 12.1：洞口两侧墙块、门洞过梁、窗洞窗台） ----------

export interface Hole { start: number; end: number; sill: number; top: number }
export interface CutBox { from: number; to: number; y0: number; y1: number; kind: 'wall' | 'sill' | 'lintel' }

/** 把一段墙按门窗洞口切开。from/to 沿墙方向、高度均为毫米；cutHeight 为剖切高（毫米，默认不剖） */
export function cutWallBoxes(start: number, end: number, height: number, holes: Hole[], cutHeight = height): CutBox[] {
  const H = Math.min(height, cutHeight);
  if (H <= 0) return [];
  const out: CutBox[] = [];
  const clip = (from: number, to: number, y0: number, y1: number, kind: CutBox['kind']) => {
    const a = Math.max(0, y0), b = Math.min(H, y1);
    if (to > from && b > a) out.push({ from, to, y0: a, y1: b, kind });
  };
  let cursor = start;
  for (const h of [...holes].sort((a, b) => a.start - b.start)) {
    clip(cursor, h.start, 0, H, 'wall');
    if (h.sill > 0) clip(h.start, h.end, 0, h.sill, 'sill');
    clip(h.start, h.end, h.top, H, 'lintel');
    cursor = h.end;
  }
  clip(cursor, end, 0, H, 'wall');
  return out;
}

/** 转角让位（方案 12.1）：竖直墙端点落在水平墙厚度范围内时，从水平墙远侧面起算，避免重叠闪烁 */
function yieldCorners(v: WallSegment, hWalls: WallSegment[]): { start: number; end: number } {
  let { start, end } = v;
  for (const h of hWalls) {
    if (h.open) continue;
    if (h.start > v.line || h.end < v.line) continue;          // 水平墙不经过这面竖直墙
    if (Math.abs(h.line - start) < h.thickness / 2) start = h.line + h.thickness / 2;
    if (Math.abs(h.line - end) < h.thickness / 2) end = h.line - h.thickness / 2;
  }
  return { start, end };
}

// ---------- 门窗造型（方案 12.1） ----------

interface OpeningCtx { design: Design; o: Opening; seg: WallSegment; h: boolean; cutH: number | undefined }

/** 门窗的框、门扇、玻璃，世界坐标（米）。剖切墙上高于剖切线的不显示（方案 12.3） */
function buildOpeningParts({ design, o, seg, h, cutH }: OpeningCtx): ScenePart[] {
  const room = design.rooms.find((r) => r.id === o.hostRoomId);
  if (!room) return [];
  const span = openingSpan(room, o.side, o.offset, o.width);
  const parts: ScenePart[] = [];
  const ref = { kind: 'opening' as const, id: o.id };
  const t = seg.thickness / 1000;
  const ow = o.width / 1000;
  const oh = o.height / 1000;
  const sill = o.sill / 1000;
  const colors = openingColors(design, o);

  // 剖切墙上门窗整体不显示（墙已降到剖切高，门窗都超出）
  if (cutH !== undefined && o.sill + o.height > cutH) return parts;

  const line = seg.line / 1000;
  const along0 = span.start / 1000, along1 = span.end / 1000;
  const put = (along: number, y: number, across: number, sAlong: number, sY: number, sAcross: number, color: string, material: MaterialId) => {
    const pos: [number, number, number] = h ? [along, y, line + across] : [line + across, y, along];
    const size: [number, number, number] = h ? [sAlong, sY, sAcross] : [sAcross, sY, sAlong];
    parts.push({ pos, size, radius: 0.008, color, material, kind: 'opening', ref });
  };

  // 框：门三条（两侧 + 顶），窗四条（多一条底框）
  const fw = 0.05;
  const fd = Math.max(0.04, t * 0.5);
  put(along0 + fw / 2, sill + oh / 2, 0, fw, oh, fd, colors.frame, 'matte');
  put(along1 - fw / 2, sill + oh / 2, 0, fw, oh, fd, colors.frame, 'matte');
  put((along0 + along1) / 2, sill + oh - fw / 2, 0, ow, fw, fd, colors.frame, 'matte');
  if (o.kind === 'window') put((along0 + along1) / 2, sill + fw / 2, 0, ow, fw, fd, colors.frame, 'matte');

  if (o.kind === 'window') {
    put((along0 + along1) / 2, sill + oh / 2, 0, Math.max(0.05, ow - fw * 2), Math.max(0.05, oh - fw * 2), 0.02, '#D8E4EA', 'glass');
    return parts;
  }
  if (o.openMode === 'none' || !colors.leaf) return parts;

  const leafW = Math.max(0.05, ow - fw * 2);
  const leafH = Math.max(0.05, oh - fw);

  if (o.openMode === 'sliding') {
    // 移门：半开，门扇沿滑向平移出洞口，贴墙内侧
    const slide = o.slideTo === 'end' ? 1 : -1;
    put((along0 + along1) / 2 + slide * leafW * 0.45, sill + leafH / 2, -t / 2 - 0.022, leafW, leafH, 0.04, colors.leaf, 'wood');
    return parts;
  }

  // 平开门：微开 30° 显示开向（DOOR-05）。铰链端、开向房间、墙朝向共同决定门扇位置
  const hingeStart = o.hinge !== 'end';
  const hingeAlong = (hingeStart ? along0 + fw : along1 - fw);
  const dir = hingeStart ? 1 : -1;                     // 门扇从铰链指向另一端（沿墙方向）
  const hostSide = (seg.plus?.roomId === o.hostRoomId ? 1 : -1) * (o.swingInto === 'other' ? -1 : 1);
  const theta = (30 * Math.PI) / 180;
  const ux = h ? dir : 0, uz = h ? 0 : dir;            // 沿墙方向（世界 XZ）
  const nx = h ? 0 : hostSide, nz = h ? hostSide : 0;  // 开向法向
  const dx = ux * Math.cos(theta) + nx * Math.sin(theta);
  const dz = uz * Math.cos(theta) + nz * Math.sin(theta);
  const hx = h ? hingeAlong : line;                    // 铰链点（世界）
  const hz = h ? line : hingeAlong;
  parts.push({
    pos: [hx + dx * (leafW / 2) + nx * 0.021, sill + leafH / 2, hz + dz * (leafW / 2) + nz * 0.021],
    size: [leafW, leafH, 0.04],
    rotY: (Math.atan2(-dz, dx) * 180) / Math.PI,
    radius: 0.015, color: colors.leaf, material: 'wood', kind: 'opening', ref,
  });
  return parts;
}

// ---------- 总装 ----------

export function describeScene(design: Design, opts: DescribeOpts = {}): SceneSpec {
  const derived = deriveWalls(design);
  const scope = opts.scope ?? 'house';
  const cutKeys = opts.cutWallKeys;
  const cutH = opts.cutHeight ?? 1000;

  const inScope = (roomId: string) => scope === 'house' || scope.roomId === roomId;
  const rooms = design.rooms.filter((r) => inScope(r.id));
  const roomOf = (id: string) => design.rooms.find((r) => r.id === id);
  const parts: ScenePart[] = [];

  // 地板：每房间一块薄板（轴线矩形，厚 30mm）；开放连接的两间地面直接相接
  for (const room of rooms) {
    const floor = roomFloor(design, room);
    parts.push({
      pos: [(room.x + room.length / 2) / 1000, -0.015, (room.y + room.width / 2) / 1000],
      size: [room.length / 1000, 0.03, room.width / 1000],
      color: floor.color, material: floor.material, kind: 'floor', ref: { kind: 'room', id: room.id },
    });
  }

  // 显示哪些墙段：全屋 = 全部已建墙；单间 = 该房间四条边上的段（含共用墙，方案 12.2）
  const showSegs: WallSegment[] = scope === 'house'
    ? derived.segments.filter((s) => !s.open)
    : [...new Set((['top', 'right', 'bottom', 'left'] as const as Side[]).flatMap((side) => derived.roomSides.get(scope.roomId)?.[side] ?? []))].filter((s) => !s.open);
  const hWalls = showSegs.filter((s) => s.orientation === 'h');

  for (const seg of showSegs) {
    const cut = (cutKeys?.has(seg.key) ?? false) ? cutH : undefined;
    const range = seg.orientation === 'v' ? yieldCorners(seg, hWalls) : { start: seg.start, end: seg.end };

    // 段上的门窗（含相邻房间持有的——共用墙上门两侧都看得到）
    const holes: { hole: Hole; opening: Opening }[] = [];
    for (const o of design.openings) {
      const host = roomOf(o.hostRoomId);
      if (!host) continue;
      const span = openingSpan(host, o.side, o.offset, o.width);
      const s = findHostSegment(o.hostRoomId, o.side, span.start, span.end, derived);
      if (s?.key === seg.key) holes.push({ hole: { start: span.start, end: span.end, sill: o.sill, top: o.sill + o.height }, opening: o });
    }

    // 两侧颜色：各自房间色；外墙朝外一面用风格墙色；单间视图里非本房间的一面用中性色
    const sideColor = (ws: { roomId: string; side: Side } | undefined) => {
      if (!ws) return exteriorFaceColor(design);
      if (scope !== 'house' && ws.roomId !== scope.roomId) return NEUTRAL;
      const r = roomOf(ws.roomId);
      return r ? wallColor(design, r, ws.side) : exteriorFaceColor(design);
    };

    for (const b of cutWallBoxes(range.start, range.end, seg.height, holes.map((x) => x.hole), cut ?? seg.height)) {
      const len = (b.to - b.from) / 1000;
      const hgt = (b.y1 - b.y0) / 1000;
      const along = ((b.from + b.to) / 2) / 1000;
      const line = seg.line / 1000;
      const t = seg.thickness / 1000;
      parts.push({
        pos: seg.orientation === 'h' ? [along, (b.y0 + b.y1) / 2000, line] : [line, (b.y0 + b.y1) / 2000, along],
        size: seg.orientation === 'h' ? [len, hgt, t] : [t, hgt, len],
        color: sideColor(seg.plus), colorB: sideColor(seg.minus),
        faceAxis: seg.orientation === 'h' ? 'z' : 'x',
        material: 'matte', kind: 'wall', ref: { kind: 'wall', id: seg.id },
      });
    }
    for (const { opening } of holes) parts.push(...buildOpeningParts({ design, o: opening, seg, h: seg.orientation === 'h', cutH: cut }));
  }

  // 家具：调用模板造型函数，部件颜色按外观继承解析（方案 6.7）。
  // 注意：cx/cy 存的是绝对画布坐标（与 validate.ts、平面画布一致；方案 6.5 写“相对房间左上角”属已记录偏差）
  for (const f of design.furniture) {
    if (!inScope(f.roomId)) continue;
    const room = roomOf(f.roomId);
    if (!room) continue;
    const cx = f.cx / 1000, cz = f.cy / 1000;
    const elev = f.elevation / 1000;
    const phi = (-f.rotation * Math.PI) / 180;   // 平面顺时针 → 3D 绕 Y 负角（方案第 5 节）
    const cos = Math.cos(phi), sin = Math.sin(phi);
    for (const shape of buildFurniture(f)) {
      const look = furniturePart(design, f, shape.partId);
      parts.push({
        pos: [cx + shape.pos[0] * cos + shape.pos[2] * sin, elev + shape.pos[1], cz - shape.pos[0] * sin + shape.pos[2] * cos],
        size: shape.size, rotY: f.rotation === 0 ? undefined : -f.rotation,
        radius: shape.radius,
        color: look?.color ?? design.style.palette.primary,
        material: look?.material ?? 'matte',
        kind: 'furniture', ref: { kind: 'furniture', id: f.id },
      });
    }
  }

  // 展示基座（方案 12.2、6.8）：全屋大基座或单间小展台；只在有房间时生成；顶面紧贴地板下方
  let center: [number, number] = [0, 0];
  let extent = 6;
  if (rooms.length) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, maxExtT = 0;
    for (const s of derived.segments) if (s.kind === 'exterior') maxExtT = Math.max(maxExtT, s.thickness);
    if (maxExtT === 0) maxExtT = design.defaults.exteriorThickness;
    for (const r of rooms) {
      x0 = Math.min(x0, r.x - maxExtT / 2); x1 = Math.max(x1, r.x + r.length + maxExtT / 2);
      z0 = Math.min(z0, r.y - maxExtT / 2); z1 = Math.max(z1, r.y + r.width + maxExtT / 2);
    }
    const conf = scope === 'house'
      ? design.display.base
      : { ...design.display.plinth, radius: 60, color: design.display.base.color, material: design.display.base.material };
    const margin = conf.margin / 1000, bh = conf.height / 1000;
    const bw = (x1 - x0) / 1000 + margin * 2, bd = (z1 - z0) / 1000 + margin * 2;
    center = [(x0 + x1) / 2000, (z0 + z1) / 2000];
    extent = Math.max(bw, bd) / 2;
    parts.push({
      pos: [center[0], -0.03 - bh / 2, center[1]],
      size: [bw, bh, bd],
      radius: conf.radius / 1000,
      color: conf.color, material: conf.material, kind: 'base',
    });
  }

  return { parts, center, extent };
}
