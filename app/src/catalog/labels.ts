// 界面和错误信息共用的中文名称
import type { FloorMaterialId, MaterialId, RoomUsage, Side } from '../model/schema';

export const SIDE_LABEL: Record<Side, string> = { top: '上', right: '右', bottom: '下', left: '左' };
export const USAGE_LABEL: Record<RoomUsage, string> = {
  living: '客厅', bedroom: '卧室', kitchen: '厨房', bathroom: '卫生间', balcony: '阳台', other: '其他',
};
export const USAGE_COLOR: Record<RoomUsage, string> = {
  living: '#EEF3FF', bedroom: '#F3EEFF', kitchen: '#FFF4E6', bathroom: '#E8F7F5', balcony: '#EEF7E8', other: '#F3F0EA',
};
export const MATERIAL_LABEL: Record<MaterialId, string> = {
  matte: '哑光纯色', wood: '木质', fabric: '布艺', metal: '金属', glass: '玻璃',
};
export const FLOOR_LABEL: Record<FloorMaterialId, string> = {
  'wood-floor': '木地板', tile: '瓷砖', concrete: '水泥', carpet: '地毯',
};
