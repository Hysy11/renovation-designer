// 设计数据的唯一定义（方案第 6 节）。类型由 Zod 定义推导，检查导入文件、检查修改指令都用这一份。
// 这里只管“格式”（字段、类型、整数）；尺寸范围等业务规则在 geometry/validate.ts 中给出中文说明。
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

export const mm = z.int(); // 毫米，整数
export const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, '颜色必须是 #RRGGBB 格式');

export const SIDES = ['top', 'right', 'bottom', 'left'] as const;
export const Side = z.enum(SIDES);
export type Side = z.infer<typeof Side>;

export const ROOM_USAGES = ['living', 'bedroom', 'kitchen', 'bathroom', 'balcony', 'other'] as const;
export const RoomUsage = z.enum(ROOM_USAGES);
export type RoomUsage = z.infer<typeof RoomUsage>;

export const FLOOR_MATERIALS = ['wood-floor', 'tile', 'concrete', 'carpet'] as const;
export const FloorMaterialId = z.enum(FLOOR_MATERIALS);
export type FloorMaterialId = z.infer<typeof FloorMaterialId>;

export const MATERIALS = ['matte', 'wood', 'fabric', 'metal', 'glass'] as const;
export const MaterialId = z.enum(MATERIALS);
export type MaterialId = z.infer<typeof MaterialId>;

export const Room = z.strictObject({
  id: z.string(),
  name: z.string(),
  usage: RoomUsage,
  x: mm,
  y: mm,
  length: mm,
  width: mm,
  planColor: color,
  floor: z.strictObject({ material: FloorMaterialId.optional(), color: color.optional() }).optional(),
  wallColors: z.partialRecord(Side, color).optional(),
});
export type Room = z.infer<typeof Room>;

export const WallOverride = z.strictObject({
  thickness: mm.optional(),
  height: mm.optional(),
  open: z.boolean().optional(),
});
export type WallOverride = z.infer<typeof WallOverride>;

export const Opening = z.strictObject({
  id: z.string(),
  kind: z.enum(['door', 'window']),
  hostRoomId: z.string(),
  side: Side,
  offset: mm,
  width: mm,
  height: mm,
  sill: mm,
  use: z.enum(['entry', 'interior']).optional(),
  openMode: z.enum(['swing', 'sliding', 'none']).optional(),
  hinge: z.enum(['start', 'end']).optional(),
  swingInto: z.enum(['host', 'other']).optional(),
  slideTo: z.enum(['start', 'end']).optional(),
  windowType: z.enum(['floor', 'standard']).optional(),
  colors: z.strictObject({ leaf: color.optional(), frame: color.optional() }).optional(),
});
export type Opening = z.infer<typeof Opening>;

export const PartAppearance = z.strictObject({ color: color.optional(), material: MaterialId.optional() });
export type PartAppearance = z.infer<typeof PartAppearance>;

export const Furniture = z.strictObject({
  id: z.string(),
  templateId: z.string(),
  name: z.string(),
  roomId: z.string(),
  cx: mm,
  cy: mm,
  rotation: z.int(),
  l: mm,
  w: mm,
  h: mm,
  elevation: mm,
  appearance: z.record(z.string(), PartAppearance).optional(),
});
export type Furniture = z.infer<typeof Furniture>;

export const PRESET_IDS = ['cozy-light-wood', 'mid-century-minimal', 'custom'] as const;
export const Palette = z.strictObject({
  primary: color,
  secondary: color,
  accent: color,
  wallColor: color,
  woodColor: color,
  metalColor: color,
  fabricColor: color,
});
export type Palette = z.infer<typeof Palette>;

export const Style = z.strictObject({
  presetId: z.enum(PRESET_IDS),
  palette: Palette,
  floor: z.strictObject({ material: FloorMaterialId, color }),
  lighting: z.strictObject({ colorTemp: z.int(), intensity: z.number() }),
});
export type Style = z.infer<typeof Style>;

export const Display = z.strictObject({
  base: z.strictObject({ margin: mm, height: mm, radius: mm, color, material: MaterialId }),
  plinth: z.strictObject({ margin: mm, height: mm }),
});
export type Display = z.infer<typeof Display>;

export const Defaults = z.strictObject({ exteriorThickness: mm, interiorThickness: mm, wallHeight: mm });
export type Defaults = z.infer<typeof Defaults>;

export const Design = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: z.int().nonnegative(),
  meta: z.strictObject({ name: z.string(), createdAt: z.string(), updatedAt: z.string() }),
  defaults: Defaults,
  rooms: z.array(Room),
  walls: z.record(z.string(), WallOverride),
  openings: z.array(Opening),
  furniture: z.array(Furniture),
  style: Style,
  display: Display,
});
export type Design = z.infer<typeof Design>;

/** 选中、差异、错误中用来指代一个对象 */
export type ObjectKind = 'room' | 'wall' | 'opening' | 'furniture' | 'style' | 'display' | 'defaults' | 'design';
export interface ObjectRef { kind: ObjectKind; id: string }
