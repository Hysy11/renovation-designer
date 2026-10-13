// 墙段推导（方案 6.3 节）与室内净尺寸（第 5 节）。纯函数，不保存任何结果。
import type { Defaults, Design, Room, Side, WallOverride } from '../model/schema';

export type WallId = string;
export type Orientation = 'h' | 'v';

/** 墙段一侧的房间。h 墙：房间在下方时 side='top'，在上方时 side='bottom'；v 墙：房间在右侧时 side='left'，在左侧时 side='right' */
export interface WallSide { roomId: string; side: Side }

export interface WallSegment {
  id: WallId;         // ext:{房间}:{边} 或 shared:{小id}|{大id}
  key: string;        // 同一个 ext 编号可能被共用墙切成几段，key = id@start 用于区分每一段
  kind: 'exterior' | 'shared';
  orientation: Orientation;
  line: number;       // h 墙为 y，v 墙为 x（墙中心线）
  start: number;      // 沿墙方向的起止（h 为 x，v 为 y），start < end
  end: number;
  plus?: WallSide;    // 坐标增大一侧（h 的下方 / v 的右侧）的房间
  minus?: WallSide;   // 坐标减小一侧的房间
  thickness: number;
  height: number;
  open: boolean;
}

export interface Derived {
  segments: WallSegment[];
  byId: Map<WallId, WallSegment[]>;
  /** 每个房间每条边上的墙段（按 start 排序） */
  roomSides: Map<string, Record<Side, WallSegment[]>>;
  /** 每个房间每条边的扣减厚度（取已建墙段中最厚的；全部开放为 0） */
  sideThickness: Map<string, Record<Side, number>>;
}

export const sharedId = (a: string, b: string): WallId => (a < b ? `shared:${a}|${b}` : `shared:${b}|${a}`);
export const extId = (roomId: string, side: Side): WallId => `ext:${roomId}:${side}`;

/** 房间某条边所在的直线与区间 */
export function roomEdge(room: Room, side: Side): { orientation: Orientation; line: number; start: number; end: number; plusSide: boolean } {
  switch (side) {
    case 'top': return { orientation: 'h', line: room.y, start: room.x, end: room.x + room.length, plusSide: true };
    case 'bottom': return { orientation: 'h', line: room.y + room.width, start: room.x, end: room.x + room.length, plusSide: false };
    case 'left': return { orientation: 'v', line: room.x, start: room.y, end: room.y + room.width, plusSide: true };
    case 'right': return { orientation: 'v', line: room.x + room.length, start: room.y, end: room.y + room.width, plusSide: false };
  }
}

export const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

interface Edge { roomId: string; side: Side; start: number; end: number; plus: boolean }

export function deriveWalls(design: Pick<Design, 'rooms' | 'walls' | 'defaults'>): Derived {
  const groups = new Map<string, { orientation: Orientation; line: number; edges: Edge[] }>();
  for (const room of design.rooms) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const e = roomEdge(room, side);
      const gk = `${e.orientation}:${e.line}`;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { orientation: e.orientation, line: e.line, edges: [] }));
      g.edges.push({ roomId: room.id, side, start: e.start, end: e.end, plus: e.plusSide });
    }
  }

  const segments: WallSegment[] = [];
  for (const g of groups.values()) {
    const cuts = [...new Set(g.edges.flatMap((e) => [e.start, e.end]))].sort((a, b) => a - b);
    let cur: WallSegment | undefined;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i]!, b = cuts[i + 1]!;
      const covers = (e: Edge) => e.start <= a && e.end >= b;
      const p = g.edges.find((e) => e.plus && covers(e));
      const m = g.edges.find((e) => !e.plus && covers(e));
      if (!p && !m) { cur = undefined; continue; }
      const plus = p && { roomId: p.roomId, side: p.side };
      const minus = m && { roomId: m.roomId, side: m.side };
      const id = plus && minus ? sharedId(plus.roomId, minus.roomId) : extId((plus ?? minus)!.roomId, (plus ?? minus)!.side);
      if (cur && cur.id === id && cur.end === a) { cur.end = b; continue; }
      cur = {
        id, key: `${id}@${a}`, kind: plus && minus ? 'shared' : 'exterior', orientation: g.orientation, line: g.line,
        start: a, end: b, plus, minus, thickness: 0, height: 0, open: false,
      };
      segments.push(cur);
    }
  }

  const byId = new Map<WallId, WallSegment[]>();
  for (const s of segments) {
    const o = resolveWall(s.id, s.kind, design.walls[s.id], design.defaults);
    s.thickness = o.thickness; s.height = o.height; s.open = o.open;
    const list = byId.get(s.id);
    if (list) list.push(s); else byId.set(s.id, [s]);
  }

  const roomSides = new Map<string, Record<Side, WallSegment[]>>();
  const sideThickness = new Map<string, Record<Side, number>>();
  for (const room of design.rooms) {
    roomSides.set(room.id, { top: [], right: [], bottom: [], left: [] });
  }
  for (const s of segments) {
    for (const ws of [s.plus, s.minus]) if (ws) roomSides.get(ws.roomId)?.[ws.side].push(s);
  }
  for (const [roomId, sides] of roomSides) {
    const t = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      sides[side].sort((x, y) => x.start - y.start);
      for (const s of sides[side]) if (!s.open) t[side] = Math.max(t[side], s.thickness);
    }
    sideThickness.set(roomId, t);
  }

  return { segments, byId, roomSides, sideThickness };
}

export function resolveWall(id: WallId, kind: 'exterior' | 'shared', o: WallOverride | undefined, d: Defaults) {
  void id;
  return {
    thickness: o?.thickness ?? (kind === 'shared' ? d.interiorThickness : d.exteriorThickness),
    height: o?.height ?? d.wallHeight,
    open: o?.open ?? false,
  };
}

/** 室内净范围，坐标相对房间轴线左上角 */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

export function interiorRect(room: Room, derived: Derived): Rect {
  const t = derived.sideThickness.get(room.id) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return { x0: t.left / 2, y0: t.top / 2, x1: room.length - t.right / 2, y1: room.width - t.bottom / 2 };
}

export function netSize(room: Room, derived: Derived): { length: number; width: number } {
  const r = interiorRect(room, derived);
  return { length: r.x1 - r.x0, width: r.y1 - r.y0 };
}

/** 两个房间是否相邻（共有一段墙） */
export function neighbours(roomId: string, derived: Derived): string[] {
  const out = new Set<string>();
  for (const s of derived.segments) {
    if (s.kind !== 'shared') continue;
    if (s.plus?.roomId === roomId && s.minus) out.add(s.minus.roomId);
    if (s.minus?.roomId === roomId && s.plus) out.add(s.plus.roomId);
  }
  return [...out];
}

/** 门窗在墙方向上的绝对区间 */
export function openingSpan(room: Room, side: Side, offset: number, width: number) {
  const e = roomEdge(room, side);
  return { orientation: e.orientation, line: e.line, start: e.start + offset, end: e.start + offset + width };
}

/** 找到完整容纳该区间、且持有房间在其一侧的墙段 */
export function findHostSegment(roomId: string, side: Side, start: number, end: number, derived: Derived): WallSegment | undefined {
  return derived.roomSides.get(roomId)?.[side].find((s) => s.start <= start && s.end >= end);
}

/** 墙段在界面和错误信息中的名称，如“客厅与卧室之间的墙”“客厅上侧外墙” */
export function wallLabel(seg: Pick<WallSegment, 'kind' | 'plus' | 'minus'>, roomName: (id: string) => string, sideLabel: (s: Side) => string): string {
  if (seg.kind === 'shared' && seg.plus && seg.minus) return `${roomName(seg.minus.roomId)}与${roomName(seg.plus.roomId)}之间的墙`;
  const ws = (seg.plus ?? seg.minus)!;
  return `${roomName(ws.roomId)}${sideLabel(ws.side)}侧外墙`;
}
