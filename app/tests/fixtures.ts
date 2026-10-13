// 测试用的小设计样例
import { createEmptyDesign } from '../src/model/defaults';
import type { Design, Furniture, Opening, Room } from '../src/model/schema';

export const NOW = '2026-10-11T00:00:00.000Z';

export function room(id: string, x: number, y: number, length: number, width: number, name = id): Room {
  return { id, name, usage: 'other', x, y, length, width, planColor: '#EEEEEE' };
}

export function door(id: string, hostRoomId: string, side: Opening['side'], offset: number, width = 900, extra: Partial<Opening> = {}): Opening {
  return {
    id, kind: 'door', hostRoomId, side, offset, width, height: 2100, sill: 0,
    use: 'interior', openMode: 'swing', hinge: 'start', swingInto: 'host', ...extra,
  };
}

export function windowOf(id: string, hostRoomId: string, side: Opening['side'], offset: number, width = 1500): Opening {
  return { id, kind: 'window', hostRoomId, side, offset, width, height: 1500, sill: 900, windowType: 'standard' };
}

export function furn(id: string, roomId: string, templateId: string, cx: number, cy: number, l: number, w: number, extra: Partial<Furniture> = {}): Furniture {
  return { id, templateId, name: id, roomId, cx, cy, rotation: 0, l, w, h: 800, elevation: 0, ...extra };
}

export function design(parts: Partial<Pick<Design, 'rooms' | 'walls' | 'openings' | 'furniture'>> = {}): Design {
  return { ...createEmptyDesign(NOW, '测试'), ...parts };
}

/** 客厅 5000×4000 在左，卧室 3500×4000 在右，完全相邻 */
export const twoRooms = () => design({ rooms: [room('r_a', 0, 0, 5000, 4000, '客厅'), room('r_b', 5000, 0, 3500, 4000, '卧室')] });
