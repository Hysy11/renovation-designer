// 外观继承（方案 6.7 节）：没有单独设置的颜色和材质，按部件角色从当前风格里取。
import type { Design, Furniture, MaterialId, Opening, Room, Side, FloorMaterialId } from '../model/schema';
import { getTemplate, type PartRole } from '../catalog/furniture';
import { SIDES } from '../model/schema';
import { openingLabel } from '../geometry/validate';

export function roleColor(d: Design, role: PartRole): string {
  const p = d.style.palette;
  switch (role) {
    case 'wood': return p.woodColor;
    case 'fabric': return p.fabricColor;
    case 'metal': return p.metalColor;
    case 'primary': return p.primary;
    case 'secondary': return p.secondary;
    case 'accent': return p.accent;
  }
}

export interface Resolved { color: string; material: MaterialId; inherited: boolean }

export function furniturePart(d: Design, f: Furniture, partId: string): Resolved | undefined {
  const part = getTemplate(f.templateId)?.parts.find((p) => p.id === partId);
  if (!part) return undefined;
  const own = f.appearance?.[partId];
  return {
    color: own?.color ?? roleColor(d, part.role),
    material: own?.material ?? part.materials[0]!,
    inherited: own?.color === undefined && own?.material === undefined,
  };
}

export const wallColor = (d: Design, room: Room, side: Side): string => room.wallColors?.[side] ?? d.style.palette.wallColor;
/** 外墙朝外的一面统一用风格墙面色（方案第 17 节第 6 条） */
export const exteriorFaceColor = (d: Design): string => d.style.palette.wallColor;

export function roomFloor(d: Design, room: Room): { material: FloorMaterialId; color: string } {
  return { material: room.floor?.material ?? d.style.floor.material, color: room.floor?.color ?? d.style.floor.color };
}

export function openingColors(d: Design, o: Opening): { leaf?: string; frame: string } {
  const p = d.style.palette;
  const frame = o.colors?.frame ?? (o.kind === 'door' ? p.woodColor : p.metalColor);
  const hasLeaf = o.kind === 'door' && o.openMode !== 'none';
  return hasLeaf ? { leaf: o.colors?.leaf ?? p.woodColor, frame } : { frame };
}

/** 每个对象的最终外观，键为“类型:编号” */
export function resolveAll(d: Design): Map<string, { label: string; look: string }> {
  const out = new Map<string, { label: string; look: string }>();
  for (const r of d.rooms) {
    const floor = roomFloor(d, r);
    out.set(`room:${r.id}`, { label: `房间「${r.name}」`, look: JSON.stringify([floor, SIDES.map((s) => wallColor(d, r, s))]) });
  }
  for (const f of d.furniture) {
    const parts = getTemplate(f.templateId)?.parts ?? [];
    out.set(`furniture:${f.id}`, { label: `家具「${f.name}」`, look: JSON.stringify(parts.map((p) => furniturePart(d, f, p.id))) });
  }
  for (const o of d.openings) out.set(`opening:${o.id}`, { label: openingLabel(d, o), look: JSON.stringify(openingColors(d, o)) });
  return out;
}

/** 修改前后最终外观变化的对象（STYLE-05：受影响对象由程序比较得出） */
export function affectedObjects(prev: Design, next: Design): { key: string; label: string }[] {
  const a = resolveAll(prev), b = resolveAll(next);
  const out: { key: string; label: string }[] = [];
  for (const [key, v] of b) {
    const before = a.get(key);
    if (before && before.look !== v.look) out.push({ key, label: v.label });
  }
  return out;
}
