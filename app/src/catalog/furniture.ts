// 家具模板的数据部分（方案 6.6 节）。3D 造型函数放在 scene3d，这里保持纯逻辑。
import type { MaterialId } from '../model/schema';

/** 部件角色决定“没单独设置时”从风格的哪个颜色继承 */
export type PartRole = 'primary' | 'secondary' | 'accent' | 'wood' | 'fabric' | 'metal';

export interface PartDef {
  id: string;
  name: string;
  role: PartRole;
  materials: MaterialId[]; // 允许的材质，第一个为默认
}

export interface FurnitureTemplate {
  id: string;
  version: number;
  category: '卧室' | '客厅' | '餐厅' | '书房' | '厨房' | '软装';
  name: string;
  size: { l: number; w: number; h: number };
  range: { l: [number, number]; w: [number, number]; h: [number, number] };
  parts: PartDef[];
  stackable: boolean; // 可叠放：与其他家具重叠时不提示
  planSymbol: 'bed' | 'wardrobe' | 'sofa' | 'table' | 'cabinet' | 'chair' | 'desk' | 'counter' | 'rug';
}

const wood: MaterialId[] = ['wood', 'matte'];
const fabric: MaterialId[] = ['fabric', 'matte'];
const metal: MaterialId[] = ['metal', 'matte'];

export const TEMPLATES: FurnitureTemplate[] = [
  {
    id: 'bed.double', version: 1, category: '卧室', name: '双人床',
    size: { l: 1800, w: 2000, h: 450 }, range: { l: [1200, 2200], w: [1900, 2200], h: [250, 700] },
    parts: [
      { id: 'frame', name: '床架', role: 'wood', materials: wood },
      { id: 'bedding', name: '床垫与被子', role: 'fabric', materials: fabric },
      { id: 'headboard', name: '床头板', role: 'wood', materials: ['wood', 'fabric', 'matte'] },
    ],
    stackable: false, planSymbol: 'bed',
  },
  {
    id: 'wardrobe.basic', version: 1, category: '卧室', name: '衣柜',
    size: { l: 1600, w: 600, h: 2200 }, range: { l: [600, 3600], w: [450, 700], h: [1200, 2800] },
    parts: [
      { id: 'body', name: '柜体', role: 'primary', materials: ['matte', 'wood'] },
      { id: 'handle', name: '把手', role: 'metal', materials: metal },
    ],
    stackable: false, planSymbol: 'wardrobe',
  },
  {
    id: 'sofa.3seat', version: 1, category: '客厅', name: '三人沙发',
    size: { l: 2200, w: 900, h: 800 }, range: { l: [1500, 3200], w: [750, 1100], h: [600, 1000] },
    parts: [
      { id: 'frame', name: '框架', role: 'fabric', materials: fabric },
      { id: 'cushion', name: '坐垫', role: 'fabric', materials: fabric },
      { id: 'legs', name: '腿', role: 'wood', materials: ['wood', 'metal'] },
    ],
    stackable: false, planSymbol: 'sofa',
  },
  {
    id: 'table.coffee', version: 1, category: '客厅', name: '茶几',
    size: { l: 1200, w: 600, h: 420 }, range: { l: [500, 1800], w: [400, 1000], h: [300, 550] },
    parts: [
      { id: 'top', name: '台面', role: 'wood', materials: ['wood', 'matte', 'glass'] },
      { id: 'legs', name: '腿', role: 'wood', materials: ['wood', 'metal'] },
    ],
    stackable: false, planSymbol: 'table',
  },
  {
    id: 'cabinet.tv', version: 1, category: '客厅', name: '电视柜',
    size: { l: 1800, w: 400, h: 500 }, range: { l: [800, 3000], w: [300, 600], h: [300, 800] },
    parts: [
      { id: 'body', name: '柜体', role: 'wood', materials: wood },
      { id: 'doors', name: '柜门', role: 'primary', materials: ['matte', 'wood'] },
    ],
    stackable: false, planSymbol: 'cabinet',
  },
  {
    id: 'table.dining', version: 1, category: '餐厅', name: '餐桌',
    size: { l: 1400, w: 800, h: 750 }, range: { l: [800, 2600], w: [600, 1200], h: [650, 800] },
    parts: [
      { id: 'top', name: '台面', role: 'wood', materials: ['wood', 'matte', 'glass'] },
      { id: 'legs', name: '腿', role: 'wood', materials: ['wood', 'metal'] },
    ],
    stackable: false, planSymbol: 'table',
  },
  {
    id: 'chair.dining', version: 1, category: '餐厅', name: '餐椅',
    size: { l: 450, w: 500, h: 850 }, range: { l: [380, 600], w: [400, 650], h: [700, 1100] },
    parts: [
      { id: 'seat', name: '座面', role: 'wood', materials: ['wood', 'fabric'] },
      { id: 'legs', name: '腿', role: 'wood', materials: ['wood', 'metal'] },
    ],
    stackable: false, planSymbol: 'chair',
  },
  {
    id: 'desk.basic', version: 1, category: '书房', name: '书桌',
    size: { l: 1200, w: 600, h: 750 }, range: { l: [800, 2000], w: [450, 900], h: [650, 800] },
    parts: [
      { id: 'top', name: '台面', role: 'wood', materials: ['wood', 'matte'] },
      { id: 'legs', name: '腿', role: 'metal', materials: metal },
    ],
    stackable: false, planSymbol: 'desk',
  },
  {
    id: 'kitchen.base', version: 1, category: '厨房', name: '基础橱柜',
    size: { l: 2400, w: 600, h: 850 }, range: { l: [600, 6000], w: [500, 700], h: [750, 950] },
    parts: [
      { id: 'body', name: '柜体', role: 'primary', materials: ['matte', 'wood'] },
      { id: 'counter', name: '台面', role: 'secondary', materials: ['matte'] },
      { id: 'handle', name: '把手', role: 'metal', materials: metal },
    ],
    stackable: false, planSymbol: 'counter',
  },
  {
    id: 'rug.basic', version: 1, category: '软装', name: '地毯',
    size: { l: 2000, w: 1400, h: 10 }, range: { l: [600, 4000], w: [600, 3000], h: [5, 30] },
    parts: [{ id: 'surface', name: '毯面', role: 'accent', materials: ['fabric'] }],
    stackable: true, planSymbol: 'rug',
  },
];

const byId = new Map(TEMPLATES.map((t) => [t.id, t]));
export const getTemplate = (id: string): FurnitureTemplate | undefined => byId.get(id);
