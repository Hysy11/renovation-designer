// 家具 3D 造型（方案 6.6、12.1 节）：每个模板用盒子拼出造型，输出纯数据（米），
// 不引用 three——把数据变成网格是 SceneView 的事。
// 局部坐标：原点在家具底面中心，+x 沿长（l），+z 沿宽（w，正面朝 +z），+y 向上。
import type { Furniture } from '../model/schema';

export interface PartShape {
  partId: string;                       // 对应模板部件编号，颜色由外观继承解析
  pos: [number, number, number];        // 盒子中心（米，局部坐标）
  size: [number, number, number];       // 盒子长宽高（米）
  radius?: number;                      // 圆角半径（米），微缩模型的“适度圆润”
}

type Builder = (l: number, w: number, h: number) => PartShape[];

const legs = (l: number, w: number, h: number, leg: number, partId: string): PartShape[] => {
  const inset = leg + 0.03;
  return ([
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ] as const).map(([sx, sz]) => ({
    partId, pos: [sx * (l / 2 - inset), h / 2, sz * (w / 2 - inset)] as [number, number, number],
    size: [leg * 2, h, leg * 2] as [number, number, number],
  }));
};

const BUILDERS: Record<string, Builder> = {
  // 双人床：床架 + 床垫被子 + 床头板（床头在 -z 端）
  'bed.double': (l, w, h) => {
    const headH = Math.max(0.85, h + 0.4);
    return [
      { partId: 'frame', pos: [0, 0.11, 0], size: [l, 0.22, w], radius: 0.03 },
      { partId: 'bedding', pos: [0, 0.22 + 0.08, 0.03], size: [l * 0.94, 0.16, w * 0.9], radius: 0.05 },
      { partId: 'headboard', pos: [0, headH / 2, -w / 2 + 0.05], size: [l, headH, 0.1], radius: 0.04 },
    ];
  },
  // 衣柜：柜体 + 正面把手
  'wardrobe.basic': (l, w, h) => [
    { partId: 'body', pos: [0, h / 2, 0], size: [l, h, w], radius: 0.03 },
    { partId: 'handle', pos: [0, h * 0.55, w / 2 + 0.012], size: [0.03, h * 0.25, 0.02] },
  ],
  // 三人沙发：框架（底座 + 靠背 + 两扶手）+ 坐垫 + 腿；靠背在 -z，正面朝 +z
  'sofa.3seat': (l, w, h) => [
    { partId: 'frame', pos: [0, 0.15, 0.02], size: [l, 0.3, w - 0.04], radius: 0.05 },
    { partId: 'frame', pos: [0, h / 2, -w / 2 + 0.15], size: [l, h, 0.3], radius: 0.06 },
    { partId: 'frame', pos: [-(l / 2 - 0.12), h * 0.45, 0.06], size: [0.24, h * 0.9, w * 0.85], radius: 0.07 },
    { partId: 'frame', pos: [l / 2 - 0.12, h * 0.45, 0.06], size: [0.24, h * 0.9, w * 0.85], radius: 0.07 },
    { partId: 'cushion', pos: [0, 0.35, 0.12], size: [l - 0.52, 0.1, w * 0.48], radius: 0.04 },
    ...legs(l, w, 0.06, 0.05, 'legs'),
  ],
  // 茶几 / 餐桌：台面 + 四条腿
  'table.coffee': (l, w, h) => [
    { partId: 'top', pos: [0, h - 0.03, 0], size: [l, 0.06, w], radius: 0.04 },
    ...legs(l, w, h - 0.06, 0.045, 'legs'),
  ],
  'table.dining': (l, w, h) => [
    { partId: 'top', pos: [0, h - 0.035, 0], size: [l, 0.07, w], radius: 0.04 },
    ...legs(l, w, h - 0.07, 0.05, 'legs'),
  ],
  // 电视柜：柜体 + 正面柜门
  'cabinet.tv': (l, w, h) => [
    { partId: 'body', pos: [0, h / 2, 0], size: [l, h, w], radius: 0.03 },
    { partId: 'doors', pos: [0, h * 0.45, w / 2 + 0.008], size: [l * 0.94, h * 0.8, 0.03] },
  ],
  // 餐椅：座面 + 靠背 + 四条腿
  'chair.dining': (l, w, h) => {
    const seatH = 0.45;
    return [
      { partId: 'seat', pos: [0, seatH, 0], size: [l, 0.06, w * 0.92], radius: 0.03 },
      { partId: 'seat', pos: [0, seatH + (h - seatH) / 2, -w / 2 + 0.045], size: [l, h - seatH, 0.08], radius: 0.03 },
      ...legs(l, w, seatH, 0.028, 'legs'),
    ];
  },
  // 书桌：台面 + 两侧金属腿板
  'desk.basic': (l, w, h) => [
    { partId: 'top', pos: [0, h - 0.03, 0], size: [l, 0.06, w], radius: 0.03 },
    { partId: 'legs', pos: [-(l / 2 - 0.05), (h - 0.06) / 2, 0], size: [0.05, h - 0.06, w * 0.88] },
    { partId: 'legs', pos: [l / 2 - 0.05, (h - 0.06) / 2, 0], size: [0.05, h - 0.06, w * 0.88] },
  ],
  // 基础橱柜：柜体 + 凸出台面 + 长条把手
  'kitchen.base': (l, w, h) => [
    { partId: 'body', pos: [0, (h - 0.05) / 2, -0.02], size: [l, h - 0.05, w - 0.04], radius: 0.03 },
    { partId: 'counter', pos: [0, h - 0.025, 0], size: [l + 0.04, 0.05, w + 0.04], radius: 0.02 },
    { partId: 'handle', pos: [0, h * 0.55, w / 2 + 0.012], size: [l * 0.4, 0.03, 0.02] },
  ],
  // 地毯：一整块薄板
  'rug.basic': (l, w, h) => [
    { partId: 'surface', pos: [0, h / 2, 0], size: [l, h, w], radius: 0.08 },
  ],
};

/** 未知模板的兜底：一整块盒子，保证渲染不缺对象 */
const fallback: Builder = (l, w, h) => [{ partId: 'body', pos: [0, h / 2, 0], size: [l, h, w], radius: 0.04 }];

export function buildFurniture(f: Pick<Furniture, 'templateId' | 'l' | 'w' | 'h'>): PartShape[] {
  const b = BUILDERS[f.templateId] ?? fallback;
  return b(f.l / 1000, f.w / 1000, f.h / 1000);
}
