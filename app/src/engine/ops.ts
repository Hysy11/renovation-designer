// 修改指令的定义（方案 7.1 节）。界面、AI、测试都只能用这些指令改设计。
// Zod 严格模式：未知指令、未知字段、错误类型一律拒绝（AI-04）。
import { z } from 'zod';
import { color, FloorMaterialId, MaterialId, mm, RoomUsage, Side } from '../model/schema';

z.config(z.locales.zhCN());

/** 本批中新建对象的临时编号，后续指令可直接引用 */
export const TempId = z.string().regex(/^new:[\w-]+$/, '临时编号须为 new:名字');
/** 引用已有对象：正式编号或本批的临时编号 */
const Ref = z.string().min(1);

const nullable = <T extends z.ZodType>(t: T) => t.nullable().optional();

// ---------- 房间 ----------
const FloorPatch = z.strictObject({ material: nullable(FloorMaterialId), color: nullable(color) });
const WallColorsPatch = z.partialRecord(Side, color.nullable());

const RoomAdd = z.strictObject({
  op: z.literal('room.add'),
  tempId: TempId.optional(),
  room: z.strictObject({
    name: z.string().optional(), usage: RoomUsage, x: mm, y: mm, length: mm, width: mm,
    planColor: color.optional(),
    floor: z.strictObject({ material: FloorMaterialId.optional(), color: color.optional() }).optional(),
    wallColors: z.partialRecord(Side, color).optional(),
  }),
});
const RoomUpdate = z.strictObject({
  op: z.literal('room.update'),
  id: Ref,
  set: z.strictObject({
    name: z.string().optional(), usage: RoomUsage.optional(), x: mm.optional(), y: mm.optional(),
    length: mm.optional(), width: mm.optional(), planColor: color.optional(),
    floor: FloorPatch.nullable().optional(),        // null 表示恢复跟随风格
    wallColors: WallColorsPatch.nullable().optional(), // 按边合并；某边为 null 表示该边恢复跟随风格
  }).optional(),
  add: z.strictObject({ x: mm.optional(), y: mm.optional(), length: mm.optional(), width: mm.optional() }).optional(),
});
const RoomRemove = z.strictObject({ op: z.literal('room.remove'), id: Ref });

// ---------- 墙 ----------
const WallUpdate = z.strictObject({
  op: z.literal('wall.update'),
  id: z.string().min(1), // ext:{房间}:{边} 或 shared:{房间}|{房间}，可含临时编号
  set: z.strictObject({ thickness: nullable(mm), height: nullable(mm), open: nullable(z.boolean()) }).optional(), // null 表示恢复默认
  add: z.strictObject({ thickness: mm.optional(), height: mm.optional() }).optional(),
});

// ---------- 门窗 ----------
const DoorFields = {
  use: z.enum(['entry', 'interior']),
  openMode: z.enum(['swing', 'sliding', 'none']),
  hinge: z.enum(['start', 'end']),
  swingInto: z.enum(['host', 'other']),
  slideTo: z.enum(['start', 'end']),
  windowType: z.enum(['floor', 'standard']),
};
const OpeningAdd = z.strictObject({
  op: z.literal('opening.add'),
  tempId: TempId.optional(),
  opening: z.strictObject({
    kind: z.enum(['door', 'window']), hostRoomId: Ref, side: Side, offset: mm,
    width: mm.optional(), height: mm.optional(), sill: mm.optional(),
    use: DoorFields.use.optional(), openMode: DoorFields.openMode.optional(), hinge: DoorFields.hinge.optional(),
    swingInto: DoorFields.swingInto.optional(), slideTo: DoorFields.slideTo.optional(), windowType: DoorFields.windowType.optional(),
    colors: z.strictObject({ leaf: color.optional(), frame: color.optional() }).optional(),
  }),
});
const OpeningUpdate = z.strictObject({
  op: z.literal('opening.update'),
  id: Ref,
  set: z.strictObject({
    hostRoomId: Ref.optional(), side: Side.optional(), offset: mm.optional(), width: mm.optional(), height: mm.optional(), sill: mm.optional(),
    use: nullable(DoorFields.use), openMode: nullable(DoorFields.openMode), hinge: nullable(DoorFields.hinge),
    swingInto: nullable(DoorFields.swingInto), slideTo: nullable(DoorFields.slideTo), windowType: nullable(DoorFields.windowType),
    colors: z.strictObject({ leaf: nullable(color), frame: nullable(color) }).nullable().optional(),
  }).optional(),
  add: z.strictObject({ offset: mm.optional(), width: mm.optional(), height: mm.optional(), sill: mm.optional() }).optional(),
});
const OpeningRemove = z.strictObject({ op: z.literal('opening.remove'), id: Ref });

// ---------- 家具 ----------
const PartPatch = z.strictObject({ color: nullable(color), material: nullable(MaterialId) });
const FurnitureAdd = z.strictObject({
  op: z.literal('furniture.add'),
  tempId: TempId.optional(),
  furniture: z.strictObject({
    templateId: z.string(), roomId: Ref, cx: mm, cy: mm, rotation: z.int().optional(),
    l: mm.optional(), w: mm.optional(), h: mm.optional(), elevation: mm.optional(), name: z.string().optional(),
    appearance: z.record(z.string(), z.strictObject({ color: color.optional(), material: MaterialId.optional() })).optional(),
  }),
});
const FurnitureUpdate = z.strictObject({
  op: z.literal('furniture.update'),
  id: Ref,
  set: z.strictObject({
    name: z.string().optional(), roomId: Ref.optional(), cx: mm.optional(), cy: mm.optional(), rotation: z.int().optional(),
    l: mm.optional(), w: mm.optional(), h: mm.optional(), elevation: mm.optional(),
    appearance: z.record(z.string(), PartPatch.nullable()).nullable().optional(), // 按部件合并；null 表示恢复跟随风格
  }).optional(),
  add: z.strictObject({
    cx: mm.optional(), cy: mm.optional(), rotation: z.int().optional(),
    l: mm.optional(), w: mm.optional(), h: mm.optional(), elevation: mm.optional(),
  }).optional(),
});
const FurnitureRemove = z.strictObject({ op: z.literal('furniture.remove'), id: Ref });

// ---------- 风格、展示、全局 ----------
const StyleUpdate = z.strictObject({
  op: z.literal('style.update'),
  set: z.strictObject({
    palette: z.strictObject({
      primary: color.optional(), secondary: color.optional(), accent: color.optional(), wallColor: color.optional(),
      woodColor: color.optional(), metalColor: color.optional(), fabricColor: color.optional(),
    }).optional(),
    floor: z.strictObject({ material: FloorMaterialId.optional(), color: color.optional() }).optional(),
    lighting: z.strictObject({ colorTemp: z.int().optional(), intensity: z.number().optional() }).optional(),
  }),
});
const StyleApplyPreset = z.strictObject({
  op: z.literal('style.applyPreset'),
  presetId: z.enum(['cozy-light-wood', 'mid-century-minimal']),
  overrideAll: z.boolean().optional(), // 同时清除对象的单独颜色，让它们也跟随新风格
});
const DisplayUpdate = z.strictObject({
  op: z.literal('display.update'),
  set: z.strictObject({
    base: z.strictObject({ margin: mm.optional(), height: mm.optional(), radius: mm.optional(), color: color.optional(), material: MaterialId.optional() }).optional(),
    plinth: z.strictObject({ margin: mm.optional(), height: mm.optional() }).optional(),
  }),
});
const DesignUpdate = z.strictObject({ op: z.literal('design.update'), set: z.strictObject({ name: z.string().min(1) }) });
const DefaultsUpdate = z.strictObject({
  op: z.literal('defaults.update'),
  set: z.strictObject({ exteriorThickness: mm.optional(), interiorThickness: mm.optional(), wallHeight: mm.optional() }),
});
const DesignClear = z.strictObject({ op: z.literal('design.clear') });

export const Op = z.discriminatedUnion('op', [
  RoomAdd, RoomUpdate, RoomRemove, WallUpdate,
  OpeningAdd, OpeningUpdate, OpeningRemove,
  FurnitureAdd, FurnitureUpdate, FurnitureRemove,
  StyleUpdate, StyleApplyPreset, DisplayUpdate, DesignUpdate, DefaultsUpdate, DesignClear,
]);
export type Op = z.infer<typeof Op>;
export type OpName = Op['op'];
export const OP_NAMES = Op.options.map((o) => o.shape.op.value) as OpName[];

export const OpBatch = z.array(Op).min(1, '至少需要一条指令');
