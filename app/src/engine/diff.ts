// 差异列表（方案 7.2 节）：逐个对象、逐个字段比较修改前后，界面和 AI 都用它说明“改了什么”。
import type { Design, ObjectRef } from '../model/schema';
import { MATERIAL_LABEL, FLOOR_LABEL, SIDE_LABEL, USAGE_LABEL } from '../catalog/labels';
import { STYLE_PRESETS } from '../catalog/styles';
import { getTemplate } from '../catalog/furniture';
import { deriveWalls, type WallSegment } from '../geometry/walls';
import { openingLabel, roomName, segmentLabel } from '../geometry/validate';

export interface Change {
  target: ObjectRef;
  action: 'add' | 'remove' | 'update';
  field?: string;
  before?: unknown;
  after?: unknown;
  text: string; // 中文一句话
}

type Flat = Record<string, unknown>;
function flatten(v: unknown, prefix = '', out: Flat = {}): Flat {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (v !== undefined) out[prefix] = v;
  return out;
}

const FIELD: Record<string, Record<string, string>> = {
  room: {
    name: '名称', usage: '用途', x: '位置 x', y: '位置 y', length: '长', width: '宽', planColor: '平面颜色',
    'floor.material': '地面材质', 'floor.color': '地面颜色',
    'wallColors.top': '上墙颜色', 'wallColors.right': '右墙颜色', 'wallColors.bottom': '下墙颜色', 'wallColors.left': '左墙颜色',
  },
  opening: {
    kind: '类型', hostRoomId: '所属房间', side: '所在边', offset: '位置', width: '宽', height: '高', sill: '离地高度',
    use: '用途', openMode: '开启方式', hinge: '铰链位置', swingInto: '开向', slideTo: '滑动方向', windowType: '窗型',
    'colors.leaf': '门扇颜色', 'colors.frame': '框颜色',
  },
  furniture: { name: '名称', roomId: '所属房间', cx: '位置 x', cy: '位置 y', rotation: '朝向', l: '长', w: '宽', h: '高', elevation: '离地高度', templateId: '模板' },
  wall: { thickness: '厚度', height: '高度', open: '开放' },
  style: {
    presetId: '风格', 'palette.primary': '主色', 'palette.secondary': '辅色', 'palette.accent': '点缀色', 'palette.wallColor': '墙面色',
    'palette.woodColor': '木色', 'palette.metalColor': '金属色', 'palette.fabricColor': '布艺色',
    'floor.material': '默认地面材质', 'floor.color': '默认地面颜色', 'lighting.colorTemp': '色温', 'lighting.intensity': '亮度',
  },
  display: {
    'base.margin': '基座边距', 'base.height': '基座高度', 'base.radius': '基座圆角', 'base.color': '基座颜色', 'base.material': '基座材质',
    'plinth.margin': '展台边距', 'plinth.height': '展台高度',
  },
  defaults: { exteriorThickness: '默认外墙厚', interiorThickness: '默认共用墙厚', wallHeight: '默认墙高' },
  design: { name: '设计名称' },
};

const MM_FIELDS = /(^|\.)(x|y|cx|cy|length|width|height|l|w|h|offset|sill|elevation|thickness|margin|radius|exteriorThickness|interiorThickness|wallHeight)$/;
const ENUM: Record<string, Record<string, string>> = {
  usage: USAGE_LABEL, side: SIDE_LABEL, material: { ...MATERIAL_LABEL, ...FLOOR_LABEL },
  kind: { door: '门', window: '窗' }, use: { entry: '入户门', interior: '室内门' },
  openMode: { swing: '平开', sliding: '移门', none: '无门扇' }, hinge: { start: '靠参考端', end: '远离参考端' },
  swingInto: { host: '开向本房间', other: '开向另一侧' }, slideTo: { start: '滑向参考端', end: '滑向另一端' },
  windowType: { floor: '落地窗', standard: '普通窗' },
  presetId: { custom: '自定义', ...Object.fromEntries(Object.entries(STYLE_PRESETS).map(([k, v]) => [k, v.name])) },
};

function fmt(field: string, v: unknown, kind: string, names: (id: string) => string): string {
  const last = field.split('.').pop()!;
  if (v === undefined) {
    if (kind === 'wall') return '默认';
    if (/color|material/i.test(last) && kind !== 'style' && kind !== 'display') return '跟随风格';
    return '无';
  }
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (last === 'roomId' || last === 'hostRoomId') return `「${names(String(v))}」`;
  if (last === 'rotation') return `${v}°`;
  if (last === 'colorTemp') return `${v} K`;
  if (typeof v === 'number' && MM_FIELDS.test(field)) return `${v} mm`;
  const e = ENUM[last]?.[String(v)];
  return e ?? String(v);
}

function fieldLabel(kind: string, field: string, d: Design, objId: string): string {
  const m = /^appearance\.([^.]+)\.(color|material)$/.exec(field);
  if (m) {
    const f = d.furniture.find((x) => x.id === objId);
    const part = f && getTemplate(f.templateId)?.parts.find((p) => p.id === m[1]);
    return `${part?.name ?? m[1]}${m[2] === 'color' ? '颜色' : '材质'}`;
  }
  return FIELD[kind]?.[field] ?? field;
}

function compareFields(kind: ObjectRef['kind'], id: string, name: string, a: Flat, b: Flat, ctx: Ctx, out: Change[], skip?: (field: string) => boolean) {
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const before = a[field], after = b[field];
    if (before === after) continue;
    if (skip?.(field)) continue;
    const label = fieldLabel(kind, field, before === undefined ? ctx.next : ctx.prev, id);
    out.push({
      target: { kind, id }, action: 'update', field, before, after,
      text: `${name}${label}：${fmt(field, before, kind, ctx.names)} → ${fmt(field, after, kind, ctx.names)}`,
    });
  }
}

interface Ctx { prev: Design; next: Design; names: (id: string) => string }

function diffList<T extends { id: string }>(
  kind: 'room' | 'opening' | 'furniture', prevList: T[], nextList: T[], ctx: Ctx, label: (d: Design, x: T) => string,
  addText: (d: Design, x: T) => string, out: Change[], skip?: (id: string, field: string) => boolean,
) {
  const prevMap = new Map(prevList.map((x) => [x.id, x]));
  const nextMap = new Map(nextList.map((x) => [x.id, x]));
  for (const x of nextList) {
    const p = prevMap.get(x.id);
    if (!p) out.push({ target: { kind, id: x.id }, action: 'add', after: x, text: addText(ctx.next, x) });
    else compareFields(kind, x.id, label(ctx.next, x), flatten(p), flatten(x), ctx, out, (f) => skip?.(x.id, f) ?? false);
  }
  for (const p of prevList)
    if (!nextMap.has(p.id)) out.push({ target: { kind, id: p.id }, action: 'remove', before: p, text: `删除${label(ctx.prev, p)}` });
}

export function diffDesigns(prev: Design, next: Design): Change[] {
  const out: Change[] = [];
  const names = (id: string) => next.rooms.find((r) => r.id === id)?.name ?? roomName(prev, id);
  const ctx: Ctx = { prev, next, names };

  if (prev.meta.name !== next.meta.name) compareFields('design', 'design', '', { name: prev.meta.name }, { name: next.meta.name }, ctx, out);
  if (prev.defaults !== next.defaults) compareFields('defaults', 'defaults', '', flatten(prev.defaults), flatten(next.defaults), ctx, out);

  if (prev.rooms !== next.rooms)
    diffList('room', prev.rooms, next.rooms, ctx, (_, r) => `房间「${r.name}」`, (_, r) => `新增房间「${r.name}」（${r.length} × ${r.width} mm）`, out);

  if (prev.walls !== next.walls || prev.rooms !== next.rooms) diffWalls(prev, next, ctx, out);

  if (prev.openings !== next.openings)
    diffList('opening', prev.openings, next.openings, ctx, (d, o) => openingLabel(d, o), (d, o) => `新增${openingLabel(d, o)}（宽 ${o.width} mm）`, out);
  if (prev.furniture !== next.furniture) {
    // 房间整体移动时家具跟着走：这批位置变化是“跟随”而不是独立修改，差异列表不再逐件罗列
    const followed = new Set<string>();
    for (const r of next.rooms) {
      const p = prev.rooms.find((x) => x.id === r.id);
      if (!p || (p.x === r.x && p.y === r.y)) continue;
      for (const f of next.furniture) {
        const pf = prev.furniture.find((x) => x.id === f.id);
        if (pf && pf.roomId === r.id && f.cx - pf.cx === r.x - p.x && f.cy - pf.cy === r.y - p.y) followed.add(f.id);
      }
    }
    diffList('furniture', prev.furniture, next.furniture, ctx, (_, f) => `家具「${f.name}」`, (d, f) => `在「${roomName(d, f.roomId)}」新增家具「${f.name}」`, out,
      (id, field) => followed.has(id) && (field === 'cx' || field === 'cy'));
  }

  if (prev.style !== next.style) compareFields('style', 'style', '', flatten(prev.style), flatten(next.style), ctx, out);
  if (prev.display !== next.display) compareFields('display', 'display', '', flatten(prev.display), flatten(next.display), ctx, out);
  return out;
}

function diffWalls(prev: Design, next: Design, ctx: Ctx, out: Change[]) {
  const prevSegs = deriveWalls(prev).byId;
  const nextSegs = deriveWalls(next).byId;
  for (const id of new Set([...Object.keys(prev.walls), ...Object.keys(next.walls)])) {
    const a = prev.walls[id], b = next.walls[id];
    if (a === b) continue;
    const nextSeg = nextSegs.get(id)?.[0];
    const prevSeg = prevSegs.get(id)?.[0];
    if (a && !b && !nextSeg && prevSeg) {
      out.push({ target: { kind: 'wall', id }, action: 'remove', before: a, text: staleText(prev, next, prevSeg) });
      continue;
    }
    const seg = nextSeg ?? prevSeg;
    const name = seg ? segmentLabel(nextSeg ? next : prev, seg) : id;
    compareFields('wall', id, name, flatten(a ?? {}), flatten(b ?? {}), ctx, out);
  }
}

/** 房间关系变化后，墙设置失效的说明（方案第 17 节第 3 条） */
function staleText(prev: Design, next: Design, seg: WallSegment): string {
  const label = segmentLabel(prev, seg);
  if (seg.kind === 'shared' && seg.plus && seg.minus) {
    const alive = (id: string) => next.rooms.some((r) => r.id === id);
    if (alive(seg.plus.roomId) && alive(seg.minus.roomId))
      return `${roomName(prev, seg.minus.roomId)}与${roomName(prev, seg.plus.roomId)}不再相邻，原共用墙设置已移除`;
  }
  return `${label}已不存在，原设置已移除`;
}
