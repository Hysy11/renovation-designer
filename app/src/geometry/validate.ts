// 对整份设计做全量检查（方案 6.4、6.5、7.3 节）。引擎提交、试看、拖动中检查、导入都用这一个函数。
import type { Design, Furniture, ObjectRef, Opening, Room, Side } from '../model/schema';
import { getTemplate } from '../catalog/furniture';
import { MATERIAL_LABEL, SIDE_LABEL } from '../catalog/labels';
import { deriveWalls, findHostSegment, interiorRect, openingSpan, wallLabel, type Derived, type WallSegment } from './walls';

export interface Issue {
  level: 'error' | 'warning';
  code: string;
  target: ObjectRef;
  field?: string;
  message: string; // 中文原因
  hint?: string;   // 修改建议
}

/** 规则中的取值范围（设计决定，可调） */
export const LIMITS = {
  roomSize: [500, 30000],
  wallThickness: [50, 500],
  wallHeight: [2000, 4500],
  doorWidth: [500, 3000],
  windowWidth: [300, 6000],
  openingMinHeight: 200,
  colorTemp: [2700, 6500],
  intensity: [0.5, 1.5],
  displayMargin: [0, 3000],
  displayHeight: [50, 2000],
  displayRadius: [0, 300],
} as const;

const EPS = 0.5; // 毫米容差，避免旋转后浮点误差误报

const inRange = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;

// ---------- 名称 ----------

export const roomName = (d: Design, id: string) => d.rooms.find((r) => r.id === id)?.name ?? id;

export function openingLabel(d: Design, o: Opening): string {
  const kind = o.kind === 'door' ? (o.use === 'entry' ? '入户门' : '门') : '窗';
  return `${roomName(d, o.hostRoomId)}${SIDE_LABEL[o.side]}墙的${kind}`;
}

export const furnitureLabel = (f: Furniture) => `「${f.name}」`;

export function segmentLabel(d: Design, seg: Pick<WallSegment, 'kind' | 'plus' | 'minus'>): string {
  return wallLabel(seg, (id) => roomName(d, id), (s) => SIDE_LABEL[s]);
}

// ---------- 检查入口 ----------

export function validateDesign(d: Design, derived: Derived = deriveWalls(d)): Issue[] {
  const out: Issue[] = [];
  checkDefaults(d, out);
  checkRooms(d, out);
  checkWalls(d, derived, out);
  checkOpenings(d, derived, out);
  checkFurniture(d, derived, out);
  checkStyle(d, out);
  checkDisplay(d, out);
  return out;
}

const err = (out: Issue[], i: Omit<Issue, 'level'>) => out.push({ level: 'error', ...i });
const warn = (out: Issue[], i: Omit<Issue, 'level'>) => out.push({ level: 'warning', ...i });

function checkDefaults(d: Design, out: Issue[]) {
  const t: ObjectRef = { kind: 'defaults', id: 'defaults' };
  const [tlo, thi] = LIMITS.wallThickness;
  for (const [field, label] of [['exteriorThickness', '默认外墙厚'], ['interiorThickness', '默认共用墙厚']] as const) {
    if (!inRange(d.defaults[field], LIMITS.wallThickness))
      err(out, { code: 'DEFAULT_THICKNESS', target: t, field, message: `${label} ${d.defaults[field]} mm 超出范围`, hint: `请填写 ${tlo}–${thi} mm` });
  }
  if (!inRange(d.defaults.wallHeight, LIMITS.wallHeight))
    err(out, { code: 'DEFAULT_HEIGHT', target: t, field: 'wallHeight', message: `默认墙高 ${d.defaults.wallHeight} mm 超出范围`, hint: `请填写 ${LIMITS.wallHeight[0]}–${LIMITS.wallHeight[1]} mm` });
}

function checkRooms(d: Design, out: Issue[]) {
  const ids = new Set<string>();
  for (const r of d.rooms) {
    const t: ObjectRef = { kind: 'room', id: r.id };
    if (ids.has(r.id)) err(out, { code: 'DUPLICATE_ID', target: t, message: `房间编号 ${r.id} 重复` });
    ids.add(r.id);
    if (!r.name.trim()) err(out, { code: 'ROOM_NAME_EMPTY', target: t, field: 'name', message: '房间名称不能为空' });
    for (const [field, label] of [['length', '长'], ['width', '宽']] as const) {
      if (!inRange(r[field], LIMITS.roomSize))
        err(out, { code: 'ROOM_SIZE', target: t, field, message: `房间「${r.name}」的${label} ${r[field]} mm 超出范围`, hint: `请填写 ${LIMITS.roomSize[0]}–${LIMITS.roomSize[1]} mm` });
    }
  }
  for (let i = 0; i < d.rooms.length; i++) {
    for (let j = i + 1; j < d.rooms.length; j++) {
      const a = d.rooms[i]!, b = d.rooms[j]!;
      const ox = Math.min(a.x + a.length, b.x + b.length) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.width, b.y + b.width) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0)
        err(out, {
          code: 'ROOM_OVERLAP', target: { kind: 'room', id: b.id },
          message: `房间「${b.name}」与「${a.name}」重叠了 ${ox} × ${oy} mm`,
          hint: '房间之间可以共用一条边，但不能互相覆盖；请移动房间或修改长宽',
        });
    }
  }
}

function checkWalls(d: Design, derived: Derived, out: Issue[]) {
  for (const [id, o] of Object.entries(d.walls)) {
    const segs = derived.byId.get(id);
    const t: ObjectRef = { kind: 'wall', id };
    if (!segs) {
      err(out, { code: 'WALL_UNKNOWN', target: t, message: `墙 ${id} 已不存在`, hint: '这条墙设置对应的房间关系已经变化' });
      continue;
    }
    const label = segmentLabel(d, segs[0]!);
    if (o.thickness !== undefined && !inRange(o.thickness, LIMITS.wallThickness))
      err(out, { code: 'WALL_THICKNESS', target: t, field: 'thickness', message: `${label}厚度 ${o.thickness} mm 超出范围`, hint: `请填写 ${LIMITS.wallThickness[0]}–${LIMITS.wallThickness[1]} mm` });
    if (o.height !== undefined && !inRange(o.height, LIMITS.wallHeight))
      err(out, { code: 'WALL_HEIGHT', target: t, field: 'height', message: `${label}高度 ${o.height} mm 超出范围`, hint: `请填写 ${LIMITS.wallHeight[0]}–${LIMITS.wallHeight[1]} mm` });
  }
}

// ---------- 门窗 ----------

const DOOR_ONLY = ['use', 'openMode', 'hinge', 'swingInto', 'slideTo'] as const;
const FIELD_LABEL: Record<string, string> = {
  use: '用途', openMode: '开启方式', hinge: '铰链位置', swingInto: '开向', slideTo: '滑动方向', windowType: '窗型', leaf: '门扇颜色',
};

function checkOpeningFields(o: Opening, label: string, t: ObjectRef, out: Issue[]) {
  const notApplicable = (field: string, why: string) =>
    err(out, { code: 'OPENING_FIELD_NA', target: t, field, message: `${label}不适用“${FIELD_LABEL[field]}”：${why}`, hint: `请去掉 ${field}` });
  const required = (field: string) =>
    err(out, { code: 'OPENING_FIELD_REQUIRED', target: t, field, message: `${label}缺少“${FIELD_LABEL[field]}”` });

  if (o.kind === 'window') {
    for (const f of DOOR_ONLY) if (o[f] !== undefined) notApplicable(f, '这是窗');
    if (o.windowType === undefined) required('windowType');
    if (o.colors?.leaf !== undefined) notApplicable('leaf', '窗没有门扇');
    return;
  }
  if (o.windowType !== undefined) notApplicable('windowType', '这是门');
  if (o.use === undefined) required('use');
  if (o.openMode === undefined) required('openMode');
  if (o.sill !== 0) err(out, { code: 'DOOR_SILL', target: t, field: 'sill', message: `${label}的离地高度必须为 0` });
  switch (o.openMode) {
    case 'swing':
      if (o.hinge === undefined) required('hinge');
      if (o.swingInto === undefined) required('swingInto');
      if (o.slideTo !== undefined) notApplicable('slideTo', '平开门不滑动');
      break;
    case 'sliding':
      if (o.slideTo === undefined) required('slideTo');
      if (o.hinge !== undefined) notApplicable('hinge', '移门没有铰链');
      if (o.swingInto !== undefined) notApplicable('swingInto', '移门不向两侧开');
      break;
    case 'none':
      for (const f of ['hinge', 'swingInto', 'slideTo'] as const) if (o[f] !== undefined) notApplicable(f, '无门扇');
      if (o.colors?.leaf !== undefined) notApplicable('leaf', '无门扇');
      break;
  }
}

function checkOpenings(d: Design, derived: Derived, out: Issue[]) {
  const rooms = new Map(d.rooms.map((r) => [r.id, r]));
  const placed: { o: Opening; orientation: string; line: number; start: number; end: number }[] = [];
  const ids = new Set<string>();

  for (const o of d.openings) {
    const t: ObjectRef = { kind: 'opening', id: o.id };
    if (ids.has(o.id)) err(out, { code: 'DUPLICATE_ID', target: t, message: `门窗编号 ${o.id} 重复` });
    ids.add(o.id);
    const room = rooms.get(o.hostRoomId);
    if (!room) { err(out, { code: 'OPENING_HOST_MISSING', target: t, field: 'hostRoomId', message: `门窗所属房间 ${o.hostRoomId} 不存在` }); continue; }
    const label = openingLabel(d, o);
    const kindName = o.kind === 'door' ? '门' : '窗';
    checkOpeningFields(o, label, t, out);

    const range = o.kind === 'door' ? LIMITS.doorWidth : LIMITS.windowWidth;
    if (!inRange(o.width, range))
      err(out, { code: 'OPENING_WIDTH', target: t, field: 'width', message: `${label}宽 ${o.width} mm 超出范围`, hint: `${kindName}宽请填写 ${range[0]}–${range[1]} mm` });
    if (o.height < LIMITS.openingMinHeight)
      err(out, { code: 'OPENING_HEIGHT', target: t, field: 'height', message: `${label}高 ${o.height} mm 太小`, hint: `至少 ${LIMITS.openingMinHeight} mm` });
    if (o.sill < 0) err(out, { code: 'OPENING_SILL', target: t, field: 'sill', message: `${label}离地高度不能为负` });
    if (o.offset < 0) {
      err(out, { code: 'OPENING_OFFSET', target: t, field: 'offset', message: `${label}的位置 ${o.offset} mm 不能小于 0`, hint: `位置是洞口起点到${refEndName(o.side)}的距离` });
      continue;
    }

    const span = openingSpan(room, o.side, o.offset, o.width);
    const seg = findHostSegment(room.id, o.side, span.start, span.end, derived);
    if (!seg) {
      err(out, placementError(d, room, o, label, kindName, span.start, span.end, derived));
      continue;
    }
    if (seg.open) {
      err(out, { code: 'OPENING_ON_OPEN_WALL', target: t, message: `${label}所在的${segmentLabel(d, seg)}已设为开放，开放的墙上不能放${kindName}`, hint: '取消墙的开放，或把它移到其他墙上' });
      continue;
    }
    if (o.sill + o.height > seg.height)
      err(out, {
        code: 'OPENING_TOO_TALL', target: t, field: 'height',
        message: `${label}顶部 ${o.sill + o.height} mm 高出所在墙 ${seg.height} mm`,
        hint: `把${kindName}高或离地高度减小 ${o.sill + o.height - seg.height} mm，或把墙加高`,
      });
    if (o.kind === 'door' && o.use === 'entry' && seg.kind !== 'exterior')
      err(out, { code: 'ENTRY_DOOR_NOT_EXTERIOR', target: t, field: 'use', message: `入户门只能放在外墙上，现在位于${segmentLabel(d, seg)}`, hint: '改为室内门，或移到外墙' });
    if (o.kind === 'door' && o.use === 'interior' && seg.kind === 'exterior')
      warn(out, { code: 'INTERIOR_DOOR_ON_EXTERIOR', target: t, message: `室内门位于${segmentLabel(d, seg)}上，确认是否应为入户门` });
    placed.push({ o, orientation: span.orientation, line: span.line, start: span.start, end: span.end });
  }

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!, b = placed[j]!;
      if (a.orientation !== b.orientation || a.line !== b.line) continue;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap > 0)
        err(out, {
          code: 'OPENING_OVERLAP', target: { kind: 'opening', id: b.o.id },
          message: `${openingLabel(d, b.o)}与${openingLabel(d, a.o)}重叠了 ${overlap} mm`,
          hint: '同一面墙上的门窗不能互相覆盖，请移动位置或减小宽度',
        });
    }
  }
}

const refEndName = (s: Side) => (s === 'top' || s === 'bottom' ? '左端' : '上端');
const farEndName = (s: Side) => (s === 'top' || s === 'bottom' ? '右端' : '下端');

/** 门窗找不到能完整容纳它的墙段时，给出具体差多少 */
function placementError(d: Design, room: Room, o: Opening, label: string, kindName: string, start: number, end: number, derived: Derived): Omit<Issue, 'level'> {
  const t: ObjectRef = { kind: 'opening', id: o.id };
  const segs = derived.roomSides.get(room.id)?.[o.side] ?? [];
  const first = segs.find((s) => s.start <= start && s.end > start);
  if (!first) return { code: 'OPENING_OUT_OF_WALL', target: t, field: 'offset', message: `${label}的位置超出了墙的范围`, hint: `位置是洞口起点到${refEndName(o.side)}的距离` };
  const over = end - first.end;
  const next = segs.find((s) => s.start === first.end);
  const why = next
    ? `它跨过了${segmentLabel(d, first)}与${segmentLabel(d, next)}的分界，超出 ${over} mm`
    : `它${farEndName(o.side)}超出墙端 ${over} mm`;
  const maxOffset = o.offset - over;
  const maxWidth = o.width - over;
  const hints: string[] = [];
  if (maxOffset >= 0) hints.push(`把位置减小到 ${maxOffset} mm 以内`);
  if (maxWidth > 0) hints.push(`把${kindName}宽改为 ${maxWidth} mm 以下`);
  return { code: 'OPENING_OUT_OF_WALL', target: t, field: 'offset', message: `${label}放不下：${why}`, hint: hints.length ? `可以${hints.join('，或')}` : undefined };
}

// ---------- 家具 ----------

/** 家具占地四个角（房间坐标）。rotation 0° 正面朝 +y，顺时针为正（y 向下的坐标系） */
export function furnitureCorners(f: Pick<Furniture, 'cx' | 'cy' | 'l' | 'w' | 'rotation'>): [number, number][] {
  const a = (f.rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const hl = f.l / 2, hw = f.w / 2;
  return ([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]] as const).map(([x, y]) => [f.cx + x * c - y * s, f.cy + x * s + y * c]);
}

/** 两个凸四边形是否有面积重叠（分离轴），只碰边不算 */
export function polygonsOverlap(p: [number, number][], q: [number, number][]): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]!, [x2, y2] = poly[(i + 1) % poly.length]!;
      const nx = y1 - y2, ny = x2 - x1;
      const len = Math.hypot(nx, ny) || 1;
      const proj = (pts: [number, number][]) => pts.map(([x, y]) => (x * nx + y * ny) / len);
      const a = proj(p), b = proj(q);
      if (Math.max(...a) - EPS <= Math.min(...b) || Math.max(...b) - EPS <= Math.min(...a)) return false;
    }
  }
  return true;
}

function checkFurniture(d: Design, derived: Derived, out: Issue[]) {
  const rooms = new Map(d.rooms.map((r) => [r.id, r]));
  const ids = new Set<string>();
  const solid: { f: Furniture; corners: [number, number][] }[] = [];

  for (const f of d.furniture) {
    const t: ObjectRef = { kind: 'furniture', id: f.id };
    const label = furnitureLabel(f);
    if (ids.has(f.id)) err(out, { code: 'DUPLICATE_ID', target: t, message: `家具编号 ${f.id} 重复` });
    ids.add(f.id);
    const tpl = getTemplate(f.templateId);
    if (!tpl) { err(out, { code: 'FURN_TEMPLATE_UNKNOWN', target: t, field: 'templateId', message: `该家具不支持：没有模板 ${f.templateId}` }); continue; }
    const room = rooms.get(f.roomId);
    if (!room) { err(out, { code: 'FURN_ROOM_MISSING', target: t, field: 'roomId', message: `家具${label}所属房间 ${f.roomId} 不存在` }); continue; }

    for (const [field, name] of [['l', '长'], ['w', '宽'], ['h', '高']] as const) {
      const [lo, hi] = tpl.range[field];
      if (!inRange(f[field], [lo, hi]))
        err(out, { code: 'FURN_SIZE', target: t, field, message: `该家具不支持${name} ${f[field]} mm：${tpl.name}的${name}只能在 ${lo}–${hi} mm 之间` });
    }
    if (!inRange(f.rotation, [0, 359])) err(out, { code: 'FURN_ROTATION', target: t, field: 'rotation', message: `家具${label}的朝向 ${f.rotation}° 超出 0–359°` });
    if (f.elevation < 0) err(out, { code: 'FURN_ELEVATION', target: t, field: 'elevation', message: `家具${label}离地高度不能为负` });
    for (const [partId, app] of Object.entries(f.appearance ?? {})) {
      const part = tpl.parts.find((p) => p.id === partId);
      if (!part) { err(out, { code: 'FURN_PART_UNKNOWN', target: t, field: `appearance.${partId}`, message: `该家具不支持：${tpl.name}没有部件 ${partId}`, hint: `可用部件：${tpl.parts.map((p) => `${p.id}（${p.name}）`).join('、')}` }); continue; }
      if (app.material && !part.materials.includes(app.material))
        err(out, {
          code: 'FURN_MATERIAL', target: t, field: `appearance.${partId}.material`,
          message: `该家具不支持：${tpl.name}的${part.name}不能用${MATERIAL_LABEL[app.material]}`,
          hint: `可用材质：${part.materials.map((m) => MATERIAL_LABEL[m]).join('、')}`,
        });
    }

    // interiorRect 是相对房间左上角的；家具角点是绝对坐标，比较前先平移到同一坐标系
    const rel = interiorRect(room, derived);
    const r = { x0: rel.x0 + room.x, y0: rel.y0 + room.y, x1: rel.x1 + room.x, y1: rel.y1 + room.y };
    const corners = furnitureCorners(f);
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const over = {
      left: r.x0 - Math.min(...xs), right: Math.max(...xs) - r.x1,
      top: r.y0 - Math.min(...ys), bottom: Math.max(...ys) - r.y1,
    };
    const worst = (Object.entries(over) as [Side, number][]).filter(([, v]) => v > EPS);
    if (worst.length) {
      const desc = worst.map(([s, v]) => `${SIDE_LABEL[s]}侧超出 ${Math.ceil(v)} mm`).join('，');
      err(out, {
        code: 'FURN_OUT_OF_ROOM', target: t, field: 'cx',
        message: `家具${label}超出了「${room.name}」的室内范围（穿墙或放到房外）：${desc}`,
        hint: '请移动家具、缩小尺寸或改变朝向',
      });
    }
    if (!tpl.stackable) solid.push({ f, corners });
  }

  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i]!, b = solid[j]!;
      if (a.f.roomId !== b.f.roomId) continue;
      if (polygonsOverlap(a.corners, b.corners))
        warn(out, { code: 'FURN_OVERLAP', target: { kind: 'furniture', id: b.f.id }, message: `家具${furnitureLabel(b.f)}与${furnitureLabel(a.f)}有重叠` });
    }
  }
}

// ---------- 风格与展示 ----------

function checkStyle(d: Design, out: Issue[]) {
  const t: ObjectRef = { kind: 'style', id: 'style' };
  const { colorTemp, intensity } = d.style.lighting;
  if (!inRange(colorTemp, LIMITS.colorTemp))
    err(out, { code: 'STYLE_COLOR_TEMP', target: t, field: 'lighting.colorTemp', message: `色温 ${colorTemp} K 超出范围`, hint: `请填写 ${LIMITS.colorTemp[0]}–${LIMITS.colorTemp[1]} K` });
  if (!inRange(intensity, LIMITS.intensity))
    err(out, { code: 'STYLE_INTENSITY', target: t, field: 'lighting.intensity', message: `灯光亮度 ${intensity} 超出范围`, hint: `请填写 ${LIMITS.intensity[0]}–${LIMITS.intensity[1]}` });
}

function checkDisplay(d: Design, out: Issue[]) {
  const t: ObjectRef = { kind: 'display', id: 'display' };
  const checks: [string, string, number, readonly [number, number]][] = [
    ['base.margin', '基座边距', d.display.base.margin, LIMITS.displayMargin],
    ['base.height', '基座高度', d.display.base.height, LIMITS.displayHeight],
    ['base.radius', '基座圆角', d.display.base.radius, LIMITS.displayRadius],
    ['plinth.margin', '展台边距', d.display.plinth.margin, LIMITS.displayMargin],
    ['plinth.height', '展台高度', d.display.plinth.height, LIMITS.displayHeight],
  ];
  for (const [field, label, v, range] of checks)
    if (!inRange(v, range)) err(out, { code: 'DISPLAY_RANGE', target: t, field, message: `${label} ${v} mm 超出范围`, hint: `请填写 ${range[0]}–${range[1]} mm` });
}
