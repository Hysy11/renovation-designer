// 新建设计时的默认值（方案 6.1、6.7、6.8 节）。
import { SCHEMA_VERSION, type Design, type Display, type Defaults, type Style } from './schema';
import { STYLE_PRESETS, DEFAULT_PRESET } from '../catalog/styles';

export const DEFAULT_WALLS: Defaults = { exteriorThickness: 240, interiorThickness: 120, wallHeight: 2800 };

export const DEFAULT_DISPLAY: Display = {
  base: { margin: 600, height: 450, radius: 60, color: '#EFE6D8', material: 'matte' },
  plinth: { margin: 300, height: 250 },
};

export const defaultStyle = (): Style => structuredClone(STYLE_PRESETS[DEFAULT_PRESET].style);

export function createEmptyDesign(now: string, name = '我的家'): Design {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    meta: { name, createdAt: now, updatedAt: now },
    defaults: { ...DEFAULT_WALLS },
    rooms: [],
    walls: {},
    openings: [],
    furniture: [],
    style: defaultStyle(),
    display: structuredClone(DEFAULT_DISPLAY),
  };
}
