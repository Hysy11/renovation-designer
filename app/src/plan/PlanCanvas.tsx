// 平面页画布（方案 11.1、11.2 节）。SVG 按毫米直接画，缩放平移只改视口。
// 拖动中每帧用引擎试执行：不合法时红色轮廓 + 原因，松手仍不合法就退回原位。
import { useEffect, useMemo, useRef, useState } from 'react';
import { actions, useApp } from '../ui/useApp';
import { displayDesign } from '../store/designStore';
import type { Design, Furniture, Opening, Room } from '../model/schema';
import { deriveWalls, roomEdge, findHostSegment, type WallSegment } from '../geometry/walls';
import { LIMITS, furnitureCorners, type Issue } from '../geometry/validate';
import { getTemplate } from '../catalog/furniture';
import { USAGE_COLOR } from '../catalog/labels';
import { furniturePart, openingColors } from '../engine/appearance';
import {
  autoRoomName, displayGridStep, fitViewport, meters, openingGeom, roomAt, snapAxis, snapTol,
  visibleWorld, wallRect, zoomAt, type Point, type Viewport,
} from './transform';
import { FurnitureSymbol, OpeningSymbol } from './PlanSymbols';

export interface PlanCanvasProps {
  armedTemplateId: string | null;               // 从面板选了模板，等待点击放置
  onArmCancel: () => void;
  wallKey: string | null;                       // 选中的墙点到的那一段（面板加门窗时用）
  onWallPick: (key: string | null) => void;
}

// ---------- 配色 ----------
const C = {
  bg: '#FAF8F3', grid: '#EDE8DC', roomStroke: '#C6BFB1', wall: '#4A453D', openWall: '#BDB5A7',
  sel: '#3E7BB6', trial: '#C25B4E', guide: '#C25B4E', error: '#C0392B', ghost: '#B0A99B',
  label: '#5A5245', faint: '#8A8172',
};

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

type Drag =
  | { kind: 'pan'; startScreen: Point; v0: Viewport; moved: boolean }
  | { kind: 'draw'; start: Point; cur: Point }
  | { kind: 'moveRoom'; id: string; start: Point; room0: Room; x: number; y: number; guides: { axis: 'x' | 'y'; at: number }[]; error?: string }
  | { kind: 'resizeRoom'; id: string; handle: Handle; room0: Room; rect: { x: number; y: number; length: number; width: number }; guides: { axis: 'x' | 'y'; at: number }[]; error?: string }
  | { kind: 'moveOpening'; id: string; start: Point; o0: Opening; offset: number; error?: string }
  | { kind: 'moveFurniture'; id: string; start: Point; f0: Furniture; cx: number; cy: number; guides: { axis: 'x' | 'y'; at: number }[]; error?: string }
  | { kind: 'resizeFurniture'; id: string; handle: 'nw' | 'ne' | 'se' | 'sw'; f0: Furniture; start: Point; l: number; w: number; error?: string }
  | { kind: 'rotateFurniture'; id: string; f0: Furniture; startAngle: number; rotation: number; error?: string };

const noGuides = () => [] as { axis: 'x' | 'y'; at: number }[];
const R = Math.round; // 指令里的毫米一律取整（schema 的 mm 是整数），避免屏幕换算的浮点尾差进引擎

/** 引擎提示级警告 → 提示条内容；没有警告就不显示 */
const hintFromWarnings = (warnings: Issue[] | undefined) => {
  const list = (warnings ?? []).filter((w) => w.level === 'warning');
  return list.length ? { text: list.map((w) => w.message).join('；'), level: 'info' as const } : null;
};

/** 拖动状态对应的提交指令（试执行与松手提交共用一份，保证两边一致） */
function dragOps(d: Drag): unknown[] | null {
  switch (d.kind) {
    case 'moveRoom': return [{ op: 'room.update', id: d.id, set: { x: d.x, y: d.y } }];
    case 'resizeRoom': return [{ op: 'room.update', id: d.id, set: d.rect }];
    case 'moveOpening': return [{ op: 'opening.update', id: d.id, set: { offset: d.offset } }];
    case 'moveFurniture': return [{ op: 'furniture.update', id: d.id, set: { cx: d.cx, cy: d.cy } }];
    case 'resizeFurniture': return [{ op: 'furniture.update', id: d.id, set: { l: d.l, w: d.w } }];
    case 'rotateFurniture': return [{ op: 'furniture.update', id: d.id, set: { rotation: d.rotation } }];
    default: return null;
  }
}

export function PlanCanvas({ armedTemplateId, onArmCancel, wallKey, onWallPick }: PlanCanvasProps) {
  const design = useApp(displayDesign);
  const session = useApp((s) => s.session);
  const overlay = useApp((s) => s.session.overlay);
  const readOnly = session.mode !== 'edit' || overlay.type === 'history';

  const derived = useMemo(() => deriveWalls(design), [design]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [vp, setVp] = useState<Viewport>({ tx: 200, ty: 150, scale: 0.04 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hint, setHint] = useState<{ text: string; level: 'info' | 'error' } | null>(null);
  const [drawArmed, setDrawArmed] = useState(false);
  const [gridUser, setGridUser] = useState(100);
  const [hover, setHover] = useState<Point | null>(null);
  const rafRef = useRef(0);
  const fittedRef = useRef(false);

  // 画布尺寸
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 第一次有了画布尺寸就“适合窗口”；从空设计画出第一个房间时也适合一次
  const roomCount = design.rooms.length;
  const prevCount = useRef(0);
  useEffect(() => {
    if (!size.w) return;
    if (!fittedRef.current || (prevCount.current === 0 && roomCount > 0)) {
      fittedRef.current = true;
      setVp(fitViewport(roomsBounds(design), size));
    }
    prevCount.current = roomCount;
  }, [size.w, roomCount, design]);

  // 滚轮缩放（非被动监听，防止页面滚动）
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      setVp((v) => zoomAt(v, { x: e.clientX - rect.left, y: e.clientY - rect.top }, e.deltaY < 0 ? 1.12 : 1 / 1.12));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  // Esc 取消拖动
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag) { setDrag(null); setHint(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - vp.tx) / vp.scale, y: (e.clientY - r.top - vp.ty) / vp.scale };
  };
  const toScreenLocal = (p: Point): Point => ({ x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty });

  const otherEdges = (axis: 'x' | 'y', skipId?: string): number[] =>
    design.rooms.flatMap((r) => (r.id === skipId ? [] : axis === 'x' ? [r.x, r.x + r.length] : [r.y, r.y + r.width]));

  const snapOn = (e: { altKey: boolean }) => !e.altKey;

  /** 拖动里的实时检查（rAF 节流）：返回错误信息 */
  const runCheck = (d: Drag): string | undefined => {
    const ops = dragOps(d);
    if (!ops) return undefined;
    const r = actions().check(ops);
    return r.ok ? undefined : (r.errors[0]?.message ?? '修改不合法');
  };

  const moveRoom = (d: Extract<Drag, { kind: 'moveRoom' }>, e: PointerEvent, alt: boolean): Drag => {
    const p = toWorld(e);
    const raw = { x: d.room0.x + (p.x - d.start.x), y: d.room0.y + (p.y - d.start.y) };
    const tol = snapTol(vp.scale);
    const sx = snapAxis(raw.x, d.room0.length, otherEdges('x', d.id), gridUser, tol, !alt);
    const sy = snapAxis(raw.y, d.room0.width, otherEdges('y', d.id), gridUser, tol, !alt);
    const next = { ...d, x: R(sx.value), y: R(sy.value), guides: noGuides() };
    if (sx.guide !== undefined) next.guides.push({ axis: 'x', at: sx.guide });
    if (sy.guide !== undefined) next.guides.push({ axis: 'y', at: sy.guide });
    next.error = runCheck(next);
    return next;
  };

  const resizeRoom = (d: Extract<Drag, { kind: 'resizeRoom' }>, e: PointerEvent, alt: boolean): Drag => {
    const p = toWorld(e);
    const tol = snapTol(vp.scale);
    const [lo, hi] = LIMITS.roomSize;
    const ex = otherEdges('x', d.id), ey = otherEdges('y', d.id);
    const snapEdge = (axis: 'x' | 'y', raw: number) => snapAxis(raw, 0, axis === 'x' ? ex : ey, gridUser, tol, !alt);
    const h = d.handle;
    let x0 = d.room0.x, y0 = d.room0.y, x1 = d.room0.x + d.room0.length, y1 = d.room0.y + d.room0.width;
    if (h.includes('w')) x0 = R(snapEdge('x', p.x).value);
    if (h.includes('e')) x1 = R(snapEdge('x', p.x).value);
    if (h.includes('n')) y0 = R(snapEdge('y', p.y).value);
    if (h.includes('s')) y1 = R(snapEdge('y', p.y).value);
    if (x1 - x0 < lo) (h.includes('w') ? (x0 = x1 - lo) : (x1 = x0 + lo));
    if (y1 - y0 < lo) (h.includes('n') ? (y0 = y1 - lo) : (y1 = y0 + lo));
    x1 = Math.min(x1, x0 + hi); y1 = Math.min(y1, y0 + hi);
    const next: Drag = { ...d, rect: { x: x0, y: y0, length: x1 - x0, width: y1 - y0 }, guides: noGuides(), error: undefined };
    next.error = runCheck(next);
    return next;
  };

  const moveOpening = (d: Extract<Drag, { kind: 'moveOpening' }>, e: PointerEvent, alt: boolean): Drag => {
    const p = toWorld(e);
    const host = design.rooms.find((r) => r.id === d.o0.hostRoomId);
    const edge = host ? roomEdge(host, d.o0.side) : undefined;
    if (!edge) return { ...d, error: '找不到这扇门窗所在的房间' };
    const dAlong = edge.orientation === 'h' ? p.x - d.start.x : p.y - d.start.y;
    const raw = d.o0.offset + dAlong;
    const offset = R(snapAxis(raw, 0, [], gridUser, snapTol(vp.scale), !alt).value);
    const next = { ...d, offset };
    next.error = runCheck(next);
    return next;
  };

  const moveFurniture = (d: Extract<Drag, { kind: 'moveFurniture' }>, e: PointerEvent, alt: boolean): Drag => {
    const p = toWorld(e);
    const room = design.rooms.find((r) => r.id === d.f0.roomId);
    const centers = room ? [{ x: room.x + room.length / 2, y: room.y + room.width / 2 }] : [];
    const raw = { x: d.f0.cx + (p.x - d.start.x), y: d.f0.cy + (p.y - d.start.y) };
    const tol = snapTol(vp.scale);
    const sx = snapAxis(raw.x, 0, centers.map((c) => c.x), gridUser, tol, !alt);
    const sy = snapAxis(raw.y, 0, centers.map((c) => c.y), gridUser, tol, !alt);
    const next = { ...d, cx: R(sx.value), cy: R(sy.value), guides: noGuides() };
    if (sx.guide !== undefined) next.guides.push({ axis: 'x', at: sx.guide });
    if (sy.guide !== undefined) next.guides.push({ axis: 'y', at: sy.guide });
    next.error = runCheck(next);
    return next;
  };

  const resizeFurniture = (d: Extract<Drag, { kind: 'resizeFurniture' }>, e: PointerEvent): Drag => {
    const p = toWorld(e);
    const tpl = getTemplate(d.f0.templateId);
    if (!tpl) return { ...d, error: '找不到家具模板' };
    const rad = (d.f0.rotation * Math.PI) / 180;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const dl = dx * Math.cos(rad) + dy * Math.sin(rad);   // 沿家具长边
    const dw = -dx * Math.sin(rad) + dy * Math.cos(rad);  // 沿家具宽边
    const kx = d.handle.includes('e') ? 1 : -1, ky = d.handle.includes('s') ? 1 : -1;
    const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
    const next = { ...d, l: R(clamp(d.f0.l + kx * 2 * dl, tpl.range.l)), w: R(clamp(d.f0.w + ky * 2 * dw, tpl.range.w)) };
    next.error = runCheck(next);
    return next;
  };

  const rotateFurniture = (d: Extract<Drag, { kind: 'rotateFurniture' }>, e: PointerEvent): Drag => {
    const p = toWorld(e);
    const deg = (Math.atan2(p.y - d.f0.cy, p.x - d.f0.cx) * 180) / Math.PI;
    // 转动量 = 从抓取点转过的角度，叠加到原朝向上；15° 一档
    const rotation = ((Math.round((d.f0.rotation + deg - d.startAngle) / 15) * 15) % 360 + 360) % 360;
    const next = { ...d, rotation };
    next.error = runCheck(next);
    return next;
  };

  // ---------- 指针事件 ----------
  const onPointerMove = (e: React.PointerEvent) => {
    if (armedTemplateId && !drag) { setHover(toWorld(e)); return; }
    if (!drag) return;
    if (drag.kind === 'pan') {
      if (Math.abs(e.clientX - drag.startScreen.x) + Math.abs(e.clientY - drag.startScreen.y) > 3) drag.moved = true;
      setVp({ ...drag.v0, tx: drag.v0.tx + (e.clientX - drag.startScreen.x), ty: drag.v0.ty + (e.clientY - drag.startScreen.y) });
      return;
    }
    if (drag.kind === 'draw') {
      const p = toWorld(e);
      const tol = snapTol(vp.scale);
      const x = snapAxis(p.x, 0, otherEdges('x'), gridUser, tol, snapOn(e)).value;
      const y = snapAxis(p.y, 0, otherEdges('y'), gridUser, tol, snapOn(e)).value;
      setDrag({ ...drag, cur: { x, y } });
      return;
    }
    // 其他拖动按帧节流做引擎试执行
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setDrag((d) => {
        if (!d || d.kind === 'pan' || d.kind === 'draw') return d;
        const ev = new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey });
        switch (d.kind) {
          case 'moveRoom': return moveRoom(d, ev, e.altKey);
          case 'resizeRoom': return resizeRoom(d, ev, e.altKey);
          case 'moveOpening': return moveOpening(d, ev, e.altKey);
          case 'moveFurniture': return moveFurniture(d, ev, e.altKey);
          case 'resizeFurniture': return resizeFurniture(d, ev);
          case 'rotateFurniture': return rotateFurniture(d, ev);
        }
      });
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    try { svgRef.current?.releasePointerCapture?.(e.pointerId); } catch { /* 非真实指针（脚本合成）没有捕获可释放 */ }
    const d = drag;
    setDrag(null);
    if (!d) return;

    if (d.kind === 'pan') {
      if (!d.moved) {
        // 点空白：放家具 or 取消选中
        if (armedTemplateId) { placeAt(toWorld(e)); return; }
        actions().select(null); onWallPick(null);
      }
      return;
    }
    if (d.kind === 'draw') {
      const x0 = R(Math.min(d.start.x, d.cur.x)), x1 = R(Math.max(d.start.x, d.cur.x));
      const y0 = R(Math.min(d.start.y, d.cur.y)), y1 = R(Math.max(d.start.y, d.cur.y));
      const length = x1 - x0, width = y1 - y0;
      if (length < LIMITS.roomSize[0] || width < LIMITS.roomSize[0]) {
        setHint({ text: `房间太小（${meters(length)} × ${meters(width)}），长宽至少各 ${LIMITS.roomSize[0]} mm`, level: 'error' });
        return;
      }
      const r = actions().commit([{
        op: 'room.add',
        room: { name: autoRoomName(design.rooms), usage: 'other', x: x0, y: y0, length, width, planColor: USAGE_COLOR.other },
      }]);
      if (!r.ok) setHint({ text: r.message, level: 'error' });
      return;
    }
    const ops = dragOps(d);
    if (ops) {
      const check = actions().check(ops);
      if (!check.ok) {
        setHint({ text: `已退回原位置：${check.errors[0]!.message}`, level: 'error' });
        return;
      }
      const r = actions().commit(ops);
      if (!r.ok) setHint({ text: r.message, level: 'error' });
      // 提交成功但检查给出提示级警告（家具重叠、室内门在外墙等）时，短暂显示在提示条
      else setHint(hintFromWarnings(r.result?.warnings));
    }
  };

  /** 点了画布空白处：把待放置的家具放进所指房间 */
  const placeAt = (p: Point) => {
    if (!armedTemplateId) return;
    const tpl = getTemplate(armedTemplateId);
    if (!tpl) return;
    const roomId = roomAt(design.rooms, p);
    if (!roomId) { setHint({ text: `要放在房间里才能放置「${tpl.name}」`, level: 'error' }); return; }
    const snapped = snapAxis(p.x, 0, [], gridUser, snapTol(vp.scale), true).value;
    const snappedY = snapAxis(p.y, 0, [], gridUser, snapTol(vp.scale), true).value;
    const r = actions().commit([{
      op: 'furniture.add',
      furniture: { templateId: armedTemplateId, roomId, cx: snapped, cy: snappedY },
    }]);
    if (!r.ok) setHint({ text: r.message, level: 'error' });
    else setHint(hintFromWarnings(r.result?.warnings));
  };

  // ---------- 各对象的按下入口 ----------
  const capture = (e: React.PointerEvent) => {
    try { svgRef.current?.setPointerCapture?.(e.pointerId); } catch { /* 非真实指针（脚本合成）无法捕获，拖动照常进行 */ }
    setHint(null);
  };

  const downRoom = (r: Room) => (e: React.PointerEvent) => {
    e.stopPropagation();
    actions().select({ kind: 'room', id: r.id });
    if (readOnly || session.dimension !== 'room') return;
    capture(e);
    setDrag({ kind: 'moveRoom', id: r.id, start: toWorld(e), room0: r, x: r.x, y: r.y, guides: noGuides() });
  };

  const downWall = (seg: WallSegment) => (e: React.PointerEvent) => {
    e.stopPropagation();
    actions().select({ kind: 'wall', id: seg.id });
    onWallPick(seg.key);
  };

  const downOpening = (o: Opening) => (e: React.PointerEvent) => {
    e.stopPropagation();
    actions().select({ kind: 'opening', id: o.id });
    if (readOnly || session.dimension !== 'room') return;
    capture(e);
    setDrag({ kind: 'moveOpening', id: o.id, start: toWorld(e), o0: o, offset: o.offset });
  };

  const downFurniture = (f: Furniture) => (e: React.PointerEvent) => {
    e.stopPropagation();
    actions().select({ kind: 'furniture', id: f.id });
    if (readOnly || session.dimension !== 'furniture') return;
    capture(e);
    setDrag({ kind: 'moveFurniture', id: f.id, start: toWorld(e), f0: f, cx: f.cx, cy: f.cy, guides: noGuides() });
  };

  const downRoomHandle = (r: Room, handle: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    capture(e);
    setDrag({ kind: 'resizeRoom', id: r.id, handle, room0: r, rect: { x: r.x, y: r.y, length: r.length, width: r.width }, guides: noGuides() });
  };
  const downFurnCorner = (f: Furniture, handle: 'nw' | 'ne' | 'se' | 'sw') => (e: React.PointerEvent) => {
    e.stopPropagation();
    capture(e);
    setDrag({ kind: 'resizeFurniture', id: f.id, handle, f0: f, start: toWorld(e), l: f.l, w: f.w });
  };
  const downFurnRotate = (f: Furniture) => (e: React.PointerEvent) => {
    e.stopPropagation();
    capture(e);
    const p = toWorld(e);
    const startAngle = (Math.atan2(p.y - f.cy, p.x - f.cx) * 180) / Math.PI;
    setDrag({ kind: 'rotateFurniture', id: f.id, f0: f, startAngle, rotation: f.rotation });
  };

  const downBackground = (e: React.PointerEvent) => {
    if (drawArmed && !readOnly) {
      capture(e);
      const p = toWorld(e);
      const tol = snapTol(vp.scale);
      setDrag({
        kind: 'draw',
        start: { x: snapAxis(p.x, 0, otherEdges('x'), gridUser, tol, snapOn(e)).value, y: snapAxis(p.y, 0, otherEdges('y'), gridUser, tol, snapOn(e)).value },
        cur: { x: snapAxis(p.x, 0, otherEdges('x'), gridUser, tol, snapOn(e)).value, y: snapAxis(p.y, 0, otherEdges('y'), gridUser, tol, snapOn(e)).value },
      });
      return;
    }
    capture(e);
    setDrag({ kind: 'pan', startScreen: { x: e.clientX, y: e.clientY }, v0: vp, moved: false });
  };

  // ---------- 渲染 ----------
  const vis = visibleWorld(vp, size);
  const gStep = displayGridStep(gridUser, vp.scale);
  const gridLines: React.ReactNode[] = [];
  if (size.w) {
    for (let x = Math.floor(vis.x0 / gStep) * gStep; x <= vis.x1; x += gStep)
      gridLines.push(<line key={`gx${x}`} x1={x} y1={vis.y0} x2={x} y2={vis.y1} stroke={C.grid} strokeWidth={1 / vp.scale} />);
    for (let y = Math.floor(vis.y0 / gStep) * gStep; y <= vis.y1; y += gStep)
      gridLines.push(<line key={`gy${y}`} x1={vis.x0} y1={y} x2={vis.x1} y2={y} stroke={C.grid} strokeWidth={1 / vp.scale} />);
  }

  const sel = session.selection;
  const roomOf = (id: string) => design.rooms.find((r) => r.id === id);
  const furnOf = (id: string) => design.furniture.find((f) => f.id === id);
  const openOf = (id: string) => design.openings.find((o) => o.id === id);

  // 拖动中的对象用“幽灵位置”画
  const roomView = (r: Room): Room => {
    if (drag?.kind === 'moveRoom' && drag.id === r.id) return { ...r, x: drag.x, y: drag.y };
    if (drag?.kind === 'resizeRoom' && drag.id === r.id) return { ...r, ...drag.rect };
    return r;
  };
  const furnView = (f: Furniture): Furniture => {
    if (drag?.kind === 'moveFurniture' && drag.id === f.id) return { ...f, cx: drag.cx, cy: drag.cy };
    if (drag?.kind === 'resizeFurniture' && drag.id === f.id) return { ...f, l: drag.l, w: drag.w };
    if (drag?.kind === 'rotateFurniture' && drag.id === f.id) return { ...f, rotation: drag.rotation };
    return f;
  };
  const openView = (o: Opening): Opening =>
    drag?.kind === 'moveOpening' && drag.id === o.id ? { ...o, offset: drag.offset } : o;

  // 试看高亮集合
  const trialSets = useMemo(() => {
    if (overlay.type !== 'trial') return null;
    const sets = { room: new Set<string>(), wall: new Set<string>(), opening: new Set<string>(), furniture: new Set<string>() };
    for (const c of overlay.changes) {
      const s = sets[c.target.kind as keyof typeof sets];
      if (s) s.add(c.target.id);
    }
    return { sets, base: overlay.base };
  }, [overlay]);

  const dragErrorOf = (id: string): boolean =>
    !!drag && 'id' in drag && drag.id === id && !!(drag as { error?: string }).error;

  // 开口的绘制数据（含找不到墙时的兜底）
  const openingData = (o0: Opening) => {
    const o = openView(o0);
    const host = design.rooms.find((r) => r.id === o.hostRoomId);
    if (!host) return null;
    const e = roomEdge(host, o.side);
    const seg = findHostSegment(host.id, o.side, e.start + o.offset, e.start + o.offset + o.width, derived);
    const t = seg?.thickness ?? derived.sideThickness.get(host.id)?.[o.side] ?? 120;
    const g = openingGeom(o, e, t);
    const other = seg && seg.kind === 'shared' ? design.rooms.find((r) => r.id === (seg.plus?.roomId === host.id ? seg.minus?.roomId : seg.plus?.roomId)) : undefined;
    return { o, g, host, other, seg };
  };

  const sw = Math.max(1 / vp.scale, 30); // 线宽：屏幕至少 1 像素
  const pxPerMm = vp.scale;

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minWidth: 600, overflow: 'hidden', background: C.bg, cursor: drag?.kind === 'pan' ? 'grabbing' : drawArmed || armedTemplateId ? 'crosshair' : 'default' }}>
      <svg ref={svgRef} data-plan-canvas width="100%" height="100%"
        onPointerDown={downBackground} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => setHover(null)}
        style={{ touchAction: 'none', display: 'block', userSelect: 'none' }}>

        <defs>
          <marker id="warrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 1 L 9 5 L 0 9 z" fill={C.sel} />
          </marker>
        </defs>

        {/* 背景（平移的落点；也用于点空白取消选中） */}
        <rect x={0} y={0} width="100%" height="100%" fill={C.bg} />

        <g transform={`translate(${vp.tx} ${vp.ty}) scale(${vp.scale})`}>
          {gridLines}

          {/* 房间底色 */}
          {design.rooms.map((r0) => {
            const r = roomView(r0);
            const pe = session.dimension === 'room' ? 'auto' : 'none';
            return (
              <rect key={r.id} x={r.x} y={r.y} width={r.length} height={r.width} fill={r.planColor}
                stroke={C.roomStroke} strokeWidth={sw} pointerEvents={pe}
                style={{ cursor: readOnly ? 'default' : 'move' }} onPointerDown={downRoom(r0)} />
            );
          })}

          {/* 墙：先画开放边的虚线，再画实体墙 */}
          {derived.segments.filter((s) => s.open).map((s) => (
            <line key={s.key} x1={s.orientation === 'h' ? s.start : s.line} y1={s.orientation === 'h' ? s.line : s.start}
              x2={s.orientation === 'h' ? s.end : s.line} y2={s.orientation === 'h' ? s.line : s.end}
              stroke={C.openWall} strokeWidth={sw} strokeDasharray={`${sw * 4} ${sw * 3}`} pointerEvents="none" />
          ))}
          {derived.segments.filter((s) => !s.open).map((s) => {
            const rc = wallRect(s);
            const pe = session.dimension === 'room' ? 'auto' : 'none';
            const pad = 6 / vp.scale;
            return (
              <g key={s.key}>
                <rect x={rc.x} y={rc.y} width={rc.w} height={rc.h} fill={C.wall} pointerEvents="none" />
                {/* 加宽的隐形命中区，窄墙也好点 */}
                <rect x={s.orientation === 'h' ? rc.x : rc.x - pad} y={s.orientation === 'h' ? rc.y - pad : rc.y}
                  width={s.orientation === 'h' ? rc.w : rc.w + pad * 2} height={s.orientation === 'h' ? rc.h + pad * 2 : rc.h}
                  fill="transparent" pointerEvents={pe} style={{ cursor: 'pointer' }} onPointerDown={downWall(s)} />
              </g>
            );
          })}

          {/* 门窗：洞口铺两侧房间底色，再画符号 */}
          {design.openings.map((o0) => {
            const info = openingData(o0);
            if (!info) return null;
            const { o, g, host, other, seg } = info;
            const open = seg?.open ?? false;
            const along = g.orientation === 'h';
            const half = g.t / 2;
            const hostHalf = along
              ? { x: g.x0, y: g.hostSign > 0 ? g.line : g.line - half, w: g.x1 - g.x0, h: half }
              : { x: g.hostSign > 0 ? g.line : g.line - half, y: g.y0, w: half, h: g.y1 - g.y0 };
            const otherHalf = along
              ? { x: g.x0, y: g.hostSign > 0 ? g.line - half : g.line, w: g.x1 - g.x0, h: half }
              : { x: g.hostSign > 0 ? g.line - half : g.line, y: g.y0, w: half, h: g.y1 - g.y0 };
            const pe = session.dimension === 'room' ? 'auto' : 'none';
            const colors = openingColors(design, o);
            const pad = 5 / vp.scale;
            return (
              <g key={o.id} style={{ cursor: readOnly ? 'default' : 'move' }}>
                <rect x={hostHalf.x} y={hostHalf.y} width={hostHalf.w} height={hostHalf.h} fill={host.planColor} />
                <rect x={otherHalf.x} y={otherHalf.y} width={otherHalf.w} height={otherHalf.h} fill={other?.planColor ?? C.bg} />
                {!open && (
                  <OpeningSymbol o={o} g={g} leafColor={colors.leaf ?? C.wall} frameColor={colors.frame} />
                )}
                <rect x={along ? g.x0 - pad : g.x0} y={along ? g.y0 : g.y0 - pad}
                  width={along ? g.x1 - g.x0 + pad * 2 : g.x1 - g.x0} height={along ? g.y1 - g.y0 : g.y1 - g.y0 + pad * 2}
                  fill="transparent" pointerEvents={pe} onPointerDown={downOpening(o0)} />
              </g>
            );
          })}

          {/* 家具（房间维度下变淡且点不中） */}
          {design.furniture.map((f0) => {
            const f = furnView(f0);
            const tpl = getTemplate(f.templateId);
            if (!tpl) return null;
            const look = furniturePart(design, f, tpl.parts[0]!.id);
            const color = dragErrorOf(f.id) ? C.error : look?.color ?? '#6B6459';
            const pe = session.dimension === 'furniture' ? 'auto' : 'none';
            return (
              <g key={f.id} transform={`translate(${f.cx} ${f.cy}) rotate(${f.rotation})`}
                opacity={session.dimension === 'room' ? 0.45 : 1} color={color}
                style={{ cursor: readOnly || session.dimension !== 'furniture' ? 'default' : 'move' }}>
                <FurnitureSymbol kind={tpl.planSymbol} l={f.l} w={f.w} sw={sw} />
                {/* 命中区覆盖整个家具框 */}
                <rect x={-f.l / 2} y={-f.w / 2} width={f.l} height={f.w} fill="transparent" pointerEvents={pe} onPointerDown={downFurniture(f0)} />
              </g>
            );
          })}

          {/* 拖动 / 放置中的参考线 */}
          {drag && 'guides' in drag && drag.guides.map((g, i) => (
            <line key={i} x1={g.axis === 'x' ? g.at : vis.x0} y1={g.axis === 'x' ? vis.y0 : g.at}
              x2={g.axis === 'x' ? g.at : vis.x1} y2={g.axis === 'x' ? vis.y1 : g.at}
              stroke={C.guide} strokeWidth={1 / vp.scale} strokeDasharray={`${6 / vp.scale} ${4 / vp.scale}`} pointerEvents="none" />
          ))}

          {/* 画房间预览 */}
          {drag?.kind === 'draw' && (() => {
            const x0 = Math.min(drag.start.x, drag.cur.x), x1 = Math.max(drag.start.x, drag.cur.x);
            const y0 = Math.min(drag.start.y, drag.cur.y), y1 = Math.max(drag.start.y, drag.cur.y);
            return <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={USAGE_COLOR.other} fillOpacity={0.5}
              stroke={C.sel} strokeWidth={2 / vp.scale} strokeDasharray={`${8 / vp.scale} ${5 / vp.scale}`} pointerEvents="none" />;
          })()}

          {/* 待放置家具的幽灵 */}
          {armedTemplateId && hover && !drag && (() => {
            const tpl = getTemplate(armedTemplateId);
            if (!tpl) return null;
            const x = snapAxis(hover.x, 0, [], gridUser, snapTol(vp.scale), true).value;
            const y = snapAxis(hover.y, 0, [], gridUser, snapTol(vp.scale), true).value;
            const okRoom = !!roomAt(design.rooms, { x, y });
            return (
              <g transform={`translate(${x} ${y})`} opacity={0.55} color={okRoom ? '#6B6459' : C.error} pointerEvents="none">
                <FurnitureSymbol kind={tpl.planSymbol} l={tpl.size.l} w={tpl.size.w} sw={sw} />
              </g>
            );
          })()}

          {/* 试看：旧位置淡色轮廓 + 改动对象虚线高亮 */}
          {trialSets && (
            <g pointerEvents="none">
              {trialSets.base.rooms.filter((r) => trialSets.sets.room.has(r.id)).map((r) => (
                <rect key={`ghost${r.id}`} x={r.x} y={r.y} width={r.length} height={r.width} fill="none"
                  stroke={C.ghost} strokeWidth={1 / vp.scale} strokeDasharray={`${5 / vp.scale} ${4 / vp.scale}`} />
              ))}
              {trialSets.base.furniture.filter((f) => trialSets.sets.furniture.has(f.id)).map((f) => (
                <path key={`gf${f.id}`} d={polyPath(furnitureCorners(f))} fill="none"
                  stroke={C.ghost} strokeWidth={1 / vp.scale} strokeDasharray={`${5 / vp.scale} ${4 / vp.scale}`} />
              ))}
              {design.rooms.filter((r) => trialSets.sets.room.has(r.id)).map((r) => (
                <rect key={`tr${r.id}`} x={r.x} y={r.y} width={r.length} height={r.width} fill="none"
                  stroke={C.trial} strokeWidth={2 / vp.scale} strokeDasharray={`${8 / vp.scale} ${5 / vp.scale}`} />
              ))}
              {design.furniture.filter((f) => trialSets.sets.furniture.has(f.id)).map((f) => (
                <path key={`tf${f.id}`} d={polyPath(furnitureCorners(f))} fill="none"
                  stroke={C.trial} strokeWidth={2 / vp.scale} strokeDasharray={`${8 / vp.scale} ${5 / vp.scale}`} />
              ))}
              {design.openings.filter((o) => trialSets.sets.opening.has(o.id)).map((o) => {
                const info = openingData(o);
                return info ? <rect key={`to${o.id}`} x={info.g.x0} y={info.g.y0} width={info.g.x1 - info.g.x0} height={info.g.y1 - info.g.y0}
                  fill="none" stroke={C.trial} strokeWidth={2 / vp.scale} strokeDasharray={`${8 / vp.scale} ${5 / vp.scale}`} /> : null;
              })}
              {trialSets.sets.wall.size > 0 && derived.segments.filter((s) => trialSets.sets.wall.has(s.id)).map((s) => {
                const rc = wallRect(s);
                return <rect key={`tw${s.key}`} x={rc.x} y={rc.y} width={rc.w} height={rc.h} fill="none"
                  stroke={C.trial} strokeWidth={2 / vp.scale} strokeDasharray={`${8 / vp.scale} ${5 / vp.scale}`} />;
              })}
            </g>
          )}
        </g>

        {/* ---------- 屏幕坐标层：标注、选中框、控制点 ---------- */}
        <g pointerEvents="none">
          {/* 房间标注 */}
          {design.rooms.map((r0) => {
            const r = roomView(r0);
            const c = toScreenLocal({ x: r.x + r.length / 2, y: r.y + r.width / 2 });
            const pxW = r.length * pxPerMm, pxH = r.width * pxPerMm;
            const min = Math.min(pxW, pxH);
            if (min < 30) return null;
            const text = min < 60 ? r.name : `${r.name}  ${meters(r.length)} × ${meters(r.width)}（轴线）`;
            return (
              <text key={r.id} x={c.x} y={c.y} textAnchor="middle" dominantBaseline="middle"
                fontSize={min < 60 ? 11.5 : 12.5} fill={C.label} fontFamily="system-ui, sans-serif">
                {text}
              </text>
            );
          })}

          {/* 选中房间：外框 + 8 控制点 */}
          {sel?.kind === 'room' && (() => {
            const r0 = roomOf(sel.id);
            if (!r0) return null;
            const r = roomView(r0);
            const err = dragErrorOf(r.id);
            const a = toScreenLocal({ x: r.x, y: r.y }), b = toScreenLocal({ x: r.x + r.length, y: r.y + r.width });
            const pts = HANDLES.map((h) => ({ h, p: handlePos(r, h) })).map(({ h, p }) => ({ h, s: toScreenLocal(p) }));
            return (
              <g>
                <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none"
                  stroke={err ? C.error : C.sel} strokeWidth={1.5} />
                {!readOnly && pts.map(({ h, s }) => (
                  <circle key={h} cx={s.x} cy={s.y} r={5} fill="#fff" stroke={err ? C.error : C.sel} strokeWidth={1.5}
                    pointerEvents="all" style={{ cursor: `${h}-resize` }} onPointerDown={downRoomHandle(r0, h)} />
                ))}
              </g>
            );
          })()}

          {/* 选中墙：整条墙描高亮 + 参考端圆点和方向箭头 */}
          {sel?.kind === 'wall' && (() => {
            const segs = derived.byId.get(sel.id) ?? [];
            if (!segs.length) return null;
            const seg = segs.find((s) => s.key === wallKey) ?? segs[0]!;
            const ws = seg.plus && seg.minus ? seg.minus : (seg.plus ?? seg.minus)!;
            const host = roomOf(ws.roomId);
            if (!host) return null;
            const e = roomEdge(host, ws.side);
            const originWorld = e.orientation === 'h' ? { x: e.start, y: e.line } : { x: e.line, y: e.start };
            const o = toScreenLocal(originWorld);
            const dir = e.orientation === 'h' ? { x: 1, y: 0 } : { x: 0, y: 1 };
            return (
              <g>
                {segs.map((s) => {
                  const rc = wallRect(s);
                  const a = toScreenLocal({ x: rc.x, y: rc.y }), b = toScreenLocal({ x: rc.x + rc.w, y: rc.y + rc.h });
                  return <rect key={s.key} x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none" stroke={C.sel} strokeWidth={1.5} />;
                })}
                <circle cx={o.x} cy={o.y} r={4} fill={C.sel} />
                <line x1={o.x} y1={o.y} x2={o.x + dir.x * 30} y2={o.y + dir.y * 30} stroke={C.sel} strokeWidth={1.5} markerEnd="url(#warrow)" />
              </g>
            );
          })()}

          {/* 选中门窗：洞口描框 */}
          {sel?.kind === 'opening' && (() => {
            const info = openingData(openOf(sel.id)!);
            if (!info) return null;
            const a = toScreenLocal({ x: info.g.x0, y: info.g.y0 }), b = toScreenLocal({ x: info.g.x1, y: info.g.y1 });
            return <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none"
              stroke={dragErrorOf(info.o.id) ? C.error : C.sel} strokeWidth={1.5} />;
          })()}

          {/* 选中家具：外框 + 4 角控制点 + 旋转手柄 */}
          {sel?.kind === 'furniture' && (() => {
            const f0 = furnOf(sel.id);
            if (!f0) return null;
            const f = furnView(f0);
            const err = dragErrorOf(f.id);
            const corners = furnitureCorners(f).map(([x, y]) => toScreenLocal({ x, y }));
            const rad = (f.rotation * Math.PI) / 180;
            const hl = f.l / 2, hw = f.w / 2;
            const local = (x: number, y: number): Point => ({
              x: f.cx + x * Math.cos(rad) - y * Math.sin(rad),
              y: f.cy + x * Math.sin(rad) + y * Math.cos(rad),
            });
            const rotHandle = toScreenLocal(local(0, -hw - 30 / vp.scale));
            return (
              <g>
                <path d={polyPath(corners)} fill="none" stroke={err ? C.error : C.sel} strokeWidth={1.5} />
                {!readOnly && (['nw', 'ne', 'se', 'sw'] as const).map((h) => {
                  const p = toScreenLocal(local(h.includes('w') ? -hl : hl, h.includes('n') ? -hw : hw));
                  return <circle key={h} cx={p.x} cy={p.y} r={5} fill="#fff" stroke={err ? C.error : C.sel} strokeWidth={1.5}
                    pointerEvents="all" style={{ cursor: h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize' }}
                    onPointerDown={downFurnCorner(f0, h)} />;
                })}
                {!readOnly && (
                  <circle cx={rotHandle.x} cy={rotHandle.y} r={6} fill="#fff" stroke={err ? C.error : C.sel} strokeWidth={1.5}
                    pointerEvents="all" style={{ cursor: 'grab' }} onPointerDown={downFurnRotate(f0)} />
                )}
                {drag?.kind === 'rotateFurniture' && (
                  <text x={rotHandle.x} y={rotHandle.y - 12} textAnchor="middle" fontSize={12} fill={C.label} fontFamily="system-ui">{f.rotation}°</text>
                )}
                <text x={corners[0]!.x} y={corners[0]!.y - 8} fontSize={11} fill={C.faint} fontFamily="system-ui">
                  {f.name} {drag?.kind === 'resizeFurniture' ? `${Math.round(f.l)} × ${Math.round(f.w)}` : ''}
                </text>
              </g>
            );
          })()}

          {/* 拖动错误提示跟在画布底部（屏幕层下方由提示条显示，这里只画红框） */}
        </g>
      </svg>

      {/* 工具栏 */}
      <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
        {!readOnly && (
          <button onClick={() => { setDrawArmed((v) => !v); if (armedTemplateId) onArmCancel(); }}
            style={toolBtn(drawArmed)}>
            {drawArmed ? '取消画房间' : '画房间'}
          </button>
        )}
        <label style={{ ...toolBtn(), cursor: 'default' }}>网格
          <select value={gridUser} onChange={(e) => setGridUser(Number(e.target.value))} style={{ border: 'none', background: 'transparent', fontSize: 12, outline: 'none' }}>
            {[50, 100, 500].map((n) => <option key={n} value={n}>{n} mm</option>)}
          </select>
        </label>
        <button onClick={() => setVp(fitViewport(roomsBounds(design), size))} style={toolBtn()}>适合窗口</button>
      </div>

      {/* 提示条 */}
      {hint && (
        <div style={{
          position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
          maxWidth: '80%', padding: '6px 14px', borderRadius: 16, fontSize: 12.5,
          background: hint.level === 'error' ? '#F6DDD8' : '#EFE9DC', color: hint.level === 'error' ? '#7A2E24' : C.label,
          boxShadow: '0 2px 8px rgba(0,0,0,.12)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {hint.text}
        </div>
      )}
      {!hint && armedTemplateId && (
        <div style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', padding: '6px 14px', borderRadius: 16, fontSize: 12.5, background: '#EFE9DC', color: C.label }}>
          点击房间内放置「{getTemplate(armedTemplateId)?.name}」，Esc 取消
        </div>
      )}

      {/* 比例尺 */}
      <ScaleBar scale={vp.scale} />
    </div>
  );
}

// ---------- 小件 ----------

function toolBtn(active = false): React.CSSProperties {
  return {
    padding: '4px 10px', borderRadius: 14, border: `1px solid ${active ? C.sel : '#D8D2C4'}`,
    background: active ? '#E3EDF7' : '#fff', color: active ? C.sel : C.label, fontSize: 12.5, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 4,
  };
}

function ScaleBar({ scale }: { scale: number }) {
  const nice = [200, 500, 1000, 2000, 5000, 10000, 20000, 50000].filter((n) => n * scale <= 150).at(-1) ?? 200;
  const px = nice * scale;
  return (
    <div style={{ position: 'absolute', right: 14, bottom: 12, display: 'flex', alignItems: 'center', gap: 8, color: C.faint, fontSize: 11 }}>
      <div style={{ width: px, height: 0, borderTop: `2px solid ${C.faint}`, position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, top: -4, height: 4, borderLeft: `2px solid ${C.faint}` }} />
        <div style={{ position: 'absolute', right: 0, top: -4, height: 4, borderRight: `2px solid ${C.faint}` }} />
      </div>
      {nice >= 1000 ? `${nice / 1000} m` : `${nice} mm`}
    </div>
  );
}

function roomsBounds(design: Design) {
  if (!design.rooms.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of design.rooms) {
    x0 = Math.min(x0, r.x - 600); y0 = Math.min(y0, r.y - 600);
    x1 = Math.max(x1, r.x + r.length + 600); y1 = Math.max(y1, r.y + r.width + 600);
  }
  return { x0, y0, x1, y1 };
}

function handlePos(r: Room, h: Handle): Point {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.length : r.x + r.length / 2;
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.width : r.y + r.width / 2;
  return { x, y };
}

const polyPath = (pts: [number, number][] | Point[]): string =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${Array.isArray(p) ? p[0] : p.x} ${Array.isArray(p) ? p[1] : p.y}`).join(' ') + ' Z';
