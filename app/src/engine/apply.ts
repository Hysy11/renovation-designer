// 统一修改引擎（方案 7.2 节）：格式检查 → 解析引用 → 在副本上执行 → 重新推导 → 整体检查。
// 正式提交、试看、拖动中的实时检查都调用 applyOps，规则永远一致（EDIT-02）。
import { produce, type Draft } from 'immer';
import type { Design, Furniture, ObjectRef, Opening, Room, Side } from '../model/schema';
import { USAGE_COLOR, USAGE_LABEL } from '../catalog/labels';
import { getTemplate } from '../catalog/furniture';
import { STYLE_PRESETS } from '../catalog/styles';
import { randomId, type GenId, type IdPrefix } from '../model/ids';
import { deriveWalls, extId, OPPOSITE, roomEdge, sharedId, type Derived } from '../geometry/walls';
import { validateDesign, type Issue } from '../geometry/validate';
import { diffDesigns, type Change } from './diff';
import { OpBatch, OP_NAMES, type Op } from './ops';
import type { z } from 'zod';

export interface EngineOptions {
  genId?: GenId;
  now?: () => string;
}

export interface ApplyResult {
  ok: boolean;
  /** ok 为真时才有：执行后的新设计 */
  next?: Design;
  changes: Change[];
  errors: Issue[];
  /** 本次修改新出现的提示（原来就有的不重复列出） */
  warnings: Issue[];
  /** 本批临时编号 → 正式编号 */
  created: Record<string, string>;
}

class OpError extends Error {
  constructor(public issue: Omit<Issue, 'level'>) { super(issue.message); }
}

const fail = (opIndex: number, code: string, message: string, target: ObjectRef = { kind: 'design', id: 'design' }, hint?: string): never => {
  throw new OpError({ code, target, message: `第 ${opIndex + 1} 条指令：${message}`, hint });
};

/** 把 Zod 的格式错误翻成中文 Issue */
function formatIssues(err: z.ZodError, raw: unknown): Issue[] {
  return err.issues.map((i) => {
    const [idx, ...rest] = i.path;
    const n = typeof idx === 'number' ? `第 ${idx + 1} 条指令` : '指令列表';
    const opName = typeof idx === 'number' && Array.isArray(raw) ? (raw[idx] as { op?: unknown })?.op : undefined;
    let message: string;
    if (i.code === 'invalid_union' && rest.length === 1 && rest[0] === 'op')
      message = `${n}：不认识的指令 ${JSON.stringify(opName)}`;
    else message = `${n}${opName ? `（${String(opName)}）` : ''}${rest.length ? ` 的 ${rest.join('.')}` : ''}：${i.message}`;
    const hint = i.code === 'invalid_union' && rest[0] === 'op' ? `可用指令：${OP_NAMES.join('、')}` : undefined;
    return { level: 'error' as const, code: 'OP_FORMAT', target: { kind: 'design' as const, id: 'design' }, message, hint };
  });
}

const issueKey = (i: Issue) => `${i.code}|${i.target.kind}:${i.target.id}|${i.field ?? ''}|${i.message}`;

export function applyOps(prev: Design, rawOps: unknown, opts: EngineOptions = {}): ApplyResult {
  const genId = opts.genId ?? randomId;
  const now = opts.now ?? (() => new Date().toISOString());
  const created: Record<string, string> = {};

  // ① 格式检查
  const parsed = OpBatch.safeParse(rawOps);
  if (!parsed.success) return { ok: false, changes: [], errors: formatIssues(parsed.error, rawOps), warnings: [], created };

  // ②③④ 解析引用、在副本上执行、重新推导并清理失效的墙设置
  let draftResult: Design;
  try {
    draftResult = produce(prev, (d) => {
      const taken = new Set<string>([...d.rooms.map((r) => r.id), ...d.openings.map((o) => o.id), ...d.furniture.map((f) => f.id)]);
      const ctx: Ctx = {
        d, created, i: 0,
        newId: (prefix, tempId) => {
          if (tempId && created[tempId]) fail(ctx.i, 'TEMP_ID_DUPLICATE', `临时编号 ${tempId} 在本批中重复`);
          const id = genId(prefix, taken);
          taken.add(id);
          if (tempId) created[tempId] = id;
          return id;
        },
      };
      parsed.data.forEach((op, i) => { ctx.i = i; execute(ctx, op); });
      cleanStaleWalls(d);
    });
  } catch (e) {
    if (e instanceof OpError) return { ok: false, changes: [], errors: [{ level: 'error', ...e.issue }], warnings: [], created };
    throw e;
  }

  // ⑤ 整体检查
  const derived = deriveWalls(draftResult);
  const issues = validateDesign(draftResult, derived);
  const errors = issues.filter((i) => i.level === 'error');
  const before = new Set(validateDesign(prev).map(issueKey));
  const warnings = issues.filter((i) => i.level === 'warning' && !before.has(issueKey(i)));
  if (errors.length) return { ok: false, changes: [], errors, warnings, created };

  const changes = diffDesigns(prev, draftResult);
  const next = changes.length
    ? produce(draftResult, (d) => { d.revision = prev.revision + 1; d.meta.updatedAt = now(); })
    : prev;
  return { ok: true, next, changes, errors: [], warnings, created };
}

// ---------- 执行 ----------

interface Ctx {
  d: Draft<Design>;
  created: Record<string, string>;
  i: number;
  newId: (prefix: IdPrefix, tempId?: string) => string;
}

function ref(ctx: Ctx, id: string): string {
  if (!id.startsWith('new:')) return id;
  const real = ctx.created[id];
  if (!real) fail(ctx.i, 'TEMP_ID_UNKNOWN', `临时编号 ${id} 在本批前面的指令中还没有创建`);
  return real!;
}

function findRoom(ctx: Ctx, id: string): Draft<Room> {
  const rid = ref(ctx, id);
  const r = ctx.d.rooms.find((x) => x.id === rid);
  if (!r) fail(ctx.i, 'NOT_FOUND', `找不到房间 ${rid}`, { kind: 'room', id: rid });
  return r!;
}
function findOpening(ctx: Ctx, id: string): Draft<Opening> {
  const oid = ref(ctx, id);
  const o = ctx.d.openings.find((x) => x.id === oid);
  if (!o) fail(ctx.i, 'NOT_FOUND', `找不到门窗 ${oid}`, { kind: 'opening', id: oid });
  return o!;
}
function findFurniture(ctx: Ctx, id: string): Draft<Furniture> {
  const fid = ref(ctx, id);
  const f = ctx.d.furniture.find((x) => x.id === fid);
  if (!f) fail(ctx.i, 'NOT_FOUND', `找不到家具 ${fid}`, { kind: 'furniture', id: fid });
  return f!;
}

/** set：直接赋值，值为 null 表示删除该可选字段 */
function assign(target: Record<string, unknown>, set: Record<string, unknown> | undefined, skip: string[] = []) {
  if (!set) return;
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined || skip.includes(k)) continue;
    if (v === null) delete target[k];
    else target[k] = v;
  }
}
/** add：在原值上加减 */
function increment(target: Record<string, unknown>, add: Record<string, number | undefined> | undefined) {
  if (!add) return;
  for (const [k, v] of Object.entries(add)) if (v !== undefined) target[k] = (target[k] as number) + v;
}
/** 按键合并的可选对象：patch 为 null 清空，键值为 null 删除该键；合并后为空则整个删除 */
function mergeOptional(owner: Record<string, unknown>, key: string, patch: Record<string, unknown> | null | undefined) {
  if (patch === undefined) return;
  if (patch === null) { delete owner[key]; return; }
  const cur = { ...((owner[key] as Record<string, unknown> | undefined) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete cur[k]; else cur[k] = v;
  }
  if (Object.keys(cur).length) owner[key] = cur; else delete owner[key];
}

const normRotation = (r: number) => ((r % 360) + 360) % 360;

function execute(ctx: Ctx, op: Op) {
  const d = ctx.d;
  switch (op.op) {
    case 'room.add': {
      const { name, usage, planColor, ...rest } = op.room;
      const id = ctx.newId('r_', op.tempId);
      d.rooms.push({ id, name: name?.trim() || USAGE_LABEL[usage], usage, planColor: planColor ?? USAGE_COLOR[usage], ...rest });
      return;
    }
    case 'room.update': {
      const r = findRoom(ctx, op.id);
      const x0 = r.x, y0 = r.y;
      assign(r as never, op.set, ['floor', 'wallColors']);
      mergeOptional(r as never, 'floor', op.set?.floor);
      mergeOptional(r as never, 'wallColors', op.set?.wallColors);
      increment(r as never, op.add);
      // 移动房间时，所属家具保持相对位置整体跟随（需求 4.2）；改长宽不拉伸家具，由检查给出冲突
      const dx = r.x - x0, dy = r.y - y0;
      if (dx || dy) for (const f of d.furniture) if (f.roomId === r.id) { f.cx += dx; f.cy += dy; }
      return;
    }
    case 'room.remove':
      removeRoom(ctx, findRoom(ctx, op.id).id);
      return;
    case 'wall.update': {
      const id = normalizeWallId(ctx, op.id);
      if (!deriveWalls(d).byId.has(id)) fail(ctx.i, 'NOT_FOUND', `找不到墙 ${id}`, { kind: 'wall', id }, '墙的编号由房间关系决定：外墙为 ext:房间:边，共用墙为 shared:房间|房间');
      const cur: Record<string, unknown> = { ...(d.walls[id] ?? {}) };
      if (op.add) {
        const seg = deriveWalls(d).byId.get(id)![0]!;
        for (const k of ['thickness', 'height'] as const) if (op.add[k] !== undefined) cur[k] = seg[k] + op.add[k];
      }
      assign(cur, op.set);
      if (Object.keys(cur).length) d.walls[id] = cur; else delete d.walls[id];
      return;
    }
    case 'opening.add': {
      const o = op.opening;
      const host = findRoom(ctx, o.hostRoomId);
      const id = ctx.newId('o_', op.tempId);
      d.openings.push(withOpeningDefaults({ ...o, id, hostRoomId: host.id }));
      return;
    }
    case 'opening.update': {
      const o = findOpening(ctx, op.id);
      const set = op.set && { ...op.set, ...(op.set.hostRoomId ? { hostRoomId: findRoom(ctx, op.set.hostRoomId).id } : {}) };
      assign(o as never, set, ['colors']);
      mergeOptional(o as never, 'colors', set?.colors);
      increment(o as never, op.add);
      return;
    }
    case 'opening.remove': {
      const o = findOpening(ctx, op.id);
      d.openings.splice(d.openings.indexOf(o), 1);
      return;
    }
    case 'furniture.add': {
      const f = op.furniture;
      const tpl = getTemplate(f.templateId);
      if (!tpl) fail(ctx.i, 'FURN_TEMPLATE_UNKNOWN', `该家具不支持：没有模板 ${f.templateId}`);
      const room = findRoom(ctx, f.roomId);
      const id = ctx.newId('f_', op.tempId);
      d.furniture.push({
        id, templateId: tpl!.id, name: f.name?.trim() || tpl!.name, roomId: room.id, cx: f.cx, cy: f.cy,
        rotation: normRotation(f.rotation ?? 0), l: f.l ?? tpl!.size.l, w: f.w ?? tpl!.size.w, h: f.h ?? tpl!.size.h,
        elevation: f.elevation ?? 0, ...(f.appearance && Object.keys(f.appearance).length ? { appearance: f.appearance } : {}),
      });
      return;
    }
    case 'furniture.update': {
      const f = findFurniture(ctx, op.id);
      const set = op.set && { ...op.set, ...(op.set.roomId ? { roomId: findRoom(ctx, op.set.roomId).id } : {}) };
      assign(f as never, set, ['appearance']);
      if (set?.appearance !== undefined) {
        if (set.appearance === null) delete f.appearance;
        else {
          for (const [part, patch] of Object.entries(set.appearance)) {
            const app = (f.appearance ??= {});
            mergeOptional(app as never, part, patch);
          }
          if (f.appearance && !Object.keys(f.appearance).length) delete f.appearance;
        }
      }
      increment(f as never, op.add);
      f.rotation = normRotation(f.rotation);
      return;
    }
    case 'furniture.remove': {
      const f = findFurniture(ctx, op.id);
      d.furniture.splice(d.furniture.indexOf(f), 1);
      return;
    }
    case 'style.update': {
      const s = d.style;
      Object.assign(s.palette, stripUndef(op.set.palette));
      Object.assign(s.floor, stripUndef(op.set.floor));
      Object.assign(s.lighting, stripUndef(op.set.lighting));
      s.presetId = 'custom';
      return;
    }
    case 'style.applyPreset': {
      d.style = structuredClone(STYLE_PRESETS[op.presetId].style);
      if (op.overrideAll) {
        // 清除单独设置的颜色与地面，让它们跟随新风格；家具材质不属于风格，保留
        for (const r of d.rooms) { delete r.floor; delete r.wallColors; }
        for (const o of d.openings) delete o.colors;
        for (const f of d.furniture) {
          if (!f.appearance) continue;
          for (const [part, app] of Object.entries(f.appearance)) {
            delete app.color;
            if (app.material === undefined) delete f.appearance[part];
          }
          if (!Object.keys(f.appearance).length) delete f.appearance;
        }
      }
      return;
    }
    case 'display.update':
      Object.assign(d.display.base, stripUndef(op.set.base));
      Object.assign(d.display.plinth, stripUndef(op.set.plinth));
      return;
    case 'design.update':
      d.meta.name = op.set.name.trim();
      return;
    case 'defaults.update':
      Object.assign(d.defaults, stripUndef(op.set));
      return;
    case 'design.clear':
      d.rooms = []; d.walls = {}; d.openings = []; d.furniture = [];
      return;
  }
}

const stripUndef = <T extends object>(o: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** 新建门窗时补齐默认值；只补当前类型适用的字段 */
function withOpeningDefaults(o: Omit<Opening, 'width' | 'height' | 'sill'> & Partial<Pick<Opening, 'width' | 'height' | 'sill'>>): Opening {
  if (o.kind === 'window') {
    const windowType = o.windowType ?? 'standard';
    return {
      ...o, windowType, width: o.width ?? 1500,
      height: o.height ?? (windowType === 'floor' ? 2400 : 1500),
      sill: o.sill ?? (windowType === 'floor' ? 0 : 900),
    };
  }
  const openMode = o.openMode ?? 'swing';
  const out: Opening = { ...o, use: o.use ?? 'interior', openMode, width: o.width ?? 900, height: o.height ?? 2100, sill: o.sill ?? 0 };
  if (openMode === 'swing') { out.hinge ??= 'start'; out.swingInto ??= 'host'; }
  if (openMode === 'sliding') out.slideTo ??= 'end';
  return out;
}

/** 墙编号中的房间可以写临时编号；共用墙两侧顺序随意，统一成“小编号|大编号” */
function normalizeWallId(ctx: Ctx, id: string): string {
  let m = /^ext:(.+):(top|right|bottom|left)$/.exec(id);
  if (m) return extId(ref(ctx, m[1]!), m[2] as Side);
  m = /^shared:(.+)\|(.+)$/.exec(id);
  if (m) return sharedId(ref(ctx, m[1]!), ref(ctx, m[2]!));
  return fail(ctx.i, 'NOT_FOUND', `墙编号 ${id} 格式不对`, { kind: 'wall', id }, '外墙为 ext:房间:边，共用墙为 shared:房间|房间');
}

/**
 * 删除房间（方案第 17 节第 4 条）：房间内家具删除；外墙上的门窗删除；
 * 共用墙上的门窗改由相邻房间持有，位置换算到相邻房间的参考端，平开方向随之翻转。
 */
function removeRoom(ctx: Ctx, roomId: string) {
  const d = ctx.d;
  const plan = planRoomRemoval(d as Design, roomId);
  const transfer = new Map(plan.transferred.map((t) => [t.openingId, t]));
  d.openings = d.openings.filter((o) => o.hostRoomId !== roomId || transfer.has(o.id));
  for (const o of d.openings) {
    const t = transfer.get(o.id);
    if (!t) continue;
    o.hostRoomId = t.toRoomId; o.side = t.toSide; o.offset = t.offset;
    if (o.swingInto) o.swingInto = o.swingInto === 'host' ? 'other' : 'host';
  }
  d.furniture = d.furniture.filter((f) => f.roomId !== roomId);
  d.rooms = d.rooms.filter((r) => r.id !== roomId);
}

export interface RoomRemovalPlan {
  furniture: string[];
  removedOpenings: string[];
  transferred: { openingId: string; toRoomId: string; toSide: Opening['side']; offset: number }[];
}

/** 删除房间会带来哪些连带变化：确认框列出这些内容，引擎按同一份结果执行 */
export function planRoomRemoval(d: Design, roomId: string, derived: Derived = deriveWalls(d)): RoomRemovalPlan {
  const room = d.rooms.find((r) => r.id === roomId);
  const plan: RoomRemovalPlan = { furniture: d.furniture.filter((f) => f.roomId === roomId).map((f) => f.id), removedOpenings: [], transferred: [] };
  if (!room) return plan;
  for (const o of d.openings) {
    if (o.hostRoomId !== roomId) continue;
    const e = roomEdge(room, o.side);
    const start = e.start + o.offset;
    const seg = derived.roomSides.get(roomId)?.[o.side].find((s) => s.start <= start && s.end >= start + o.width);
    const other = seg?.kind === 'shared' ? (seg.plus?.roomId === roomId ? seg.minus : seg.plus) : undefined;
    const neighbour = other && d.rooms.find((r) => r.id === other.roomId);
    if (!other || !neighbour) { plan.removedOpenings.push(o.id); continue; }
    if (other.side !== OPPOSITE[o.side]) { plan.removedOpenings.push(o.id); continue; }
    plan.transferred.push({ openingId: o.id, toRoomId: neighbour.id, toSide: other.side, offset: start - roomEdge(neighbour, other.side).start });
  }
  return plan;
}

/** 房间关系变化后，删除已不存在的墙对应的设置；差异列表会写明原因 */
function cleanStaleWalls(d: Draft<Design>) {
  const live = deriveWalls(d as Design).byId;
  for (const id of Object.keys(d.walls)) if (!live.has(id)) delete d.walls[id];
}
