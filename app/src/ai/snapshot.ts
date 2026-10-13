// 设计快照（方案 10.3）：把当前设计压成模型好读的紧凑文本，放进系统消息。
// 每轮重新生成，历史消息里不带旧快照；墙段编号、净尺寸、相邻房间都由程序算好。
import type { Design, Furniture } from '../model/schema';
import { deriveWalls, netSize, neighbours } from '../geometry/walls';
import { getTemplate } from '../catalog/furniture';
import { USAGE_LABEL, SIDE_LABEL, FLOOR_LABEL } from '../catalog/labels';

function fmtFurniture(f: Furniture): string {
  const tpl = getTemplate(f.templateId);
  const look = f.appearance
    ? ' 外观' + Object.entries(f.appearance).map(([k, v]) => `${k}:${v.color ?? ''}${v.material ?? ''}`).join(' ')
    : '';
  return `${f.id} ${f.name}(${f.templateId}) 中心(${f.cx},${f.cy}) 朝${f.rotation}° ${f.l}×${f.w}×${f.h}` +
    (f.elevation ? ` 离地${f.elevation}` : '') + (tpl ? '' : ' [未知模板]') + look;
}

function fmtOpening(d: Design, o: Design['openings'][number]): string {
  const room = d.rooms.find((r) => r.id === o.hostRoomId);
  const bits = [`${o.id} ${o.kind === 'door' ? '门' : '窗'}(host ${room?.name ?? o.hostRoomId} ${SIDE_LABEL[o.side]})`];
  bits.push(`位${o.offset} 宽${o.width} 高${o.height}${o.sill ? ` 离地${o.sill}` : ''}`);
  if (o.kind === 'door') {
    const mode = o.openMode === 'swing' ? `平开 铰链${o.hinge ?? 'start'} 开向${o.swingInto ?? 'host'}` : o.openMode === 'sliding' ? `移门 滑向${o.slideTo ?? 'start'}` : '无门扇';
    bits.push(`${o.use === 'entry' ? '入户门' : '室内门'} ${mode}`);
  } else {
    bits.push(o.windowType === 'floor' ? '落地窗' : '普通窗');
  }
  if (o.colors) bits.push(`色${o.colors.leaf ?? ''}/${o.colors.frame ?? ''}`);
  return bits.join(' ');
}

/**
 * 设计快照文本。selectedRoomId 为当前选中房间（快照里全部房间都列出家具；
 * 选中房间排在最前并在其行尾标注“（选中）”），单位都是毫米。
 */
export function designSnapshot(design: Design, selectedRoomId?: string | null): string {
  const derived = deriveWalls(design);
  const lines: string[] = [];

  lines.push(`设计「${design.meta.name}」 版本号 rev=${design.revision}`);
  lines.push(`默认墙厚：外墙${design.defaults.exteriorThickness} 共用墙${design.defaults.interiorThickness} 层高${design.defaults.wallHeight}`);
  const st = design.style;
  lines.push(`风格 ${st.presetId}：墙${st.palette.wallColor} 主${st.palette.primary} 辅${st.palette.secondary} 点缀${st.palette.accent} 木${st.palette.woodColor} 布${st.palette.fabricColor} 金属${st.palette.metalColor}；地面 ${FLOOR_LABEL[st.floor.material]}${st.floor.color}；灯光 ${st.lighting.colorTemp}K 亮度${st.lighting.intensity}`);
  lines.push(`基座：边距${design.display.base.margin} 高${design.display.base.height} 圆角${design.display.base.radius} 色${design.display.base.color} 材质${design.display.base.material}；单间展台：边距${design.display.plinth.margin} 高${design.display.plinth.height}`);

  if (!design.rooms.length) {
    lines.push('（还没有房间，画布是空的）');
    return lines.join('\n');
  }

  const ordered = [...design.rooms].sort((a, b) => (a.id === selectedRoomId ? -1 : b.id === selectedRoomId ? 1 : 0));
  lines.push('房间（x,y=左上角；长=沿x，宽=沿y；净=室内净尺寸）:');
  for (const r of ordered) {
    const net = netSize(r, derived);
    const nb = neighbours(r.id, derived).map((id) => design.rooms.find((x) => x.id === id)?.name ?? id);
    const bits = [`- ${r.id} ${r.name}(${USAGE_LABEL[r.usage]}) x=${r.x} y=${r.y} 长${r.length} 宽${r.width} 净${net.length}×${net.width}`];
    if (nb.length) bits.push(`邻:${nb.join('、')}`);
    if (r.floor) bits.push(`地板:${r.floor.material ? FLOOR_LABEL[r.floor.material] : ''}${r.floor.color ?? ''}`);
    if (r.wallColors) bits.push(`墙面:${Object.entries(r.wallColors).map(([s, c]) => `${SIDE_LABEL[s as keyof typeof SIDE_LABEL]}${c}`).join(' ')}`);
    if (r.id === selectedRoomId) bits.push('（选中）');
    lines.push(bits.join(' '));
    for (const f of design.furniture.filter((x) => x.roomId === r.id)) lines.push(`    ${fmtFurniture(f)}`);
  }

  lines.push('墙段（编号用于 wall.update）:');
  for (const seg of derived.segments) {
    const owner = seg.kind === 'shared'
      ? `${design.rooms.find((r) => r.id === seg.minus?.roomId)?.name ?? seg.minus?.roomId}与${design.rooms.find((r) => r.id === seg.plus?.roomId)?.name ?? seg.plus?.roomId}之间`
      : `${design.rooms.find((r) => r.id === (seg.plus ?? seg.minus)?.roomId)?.name ?? ''}${SIDE_LABEL[(seg.plus ?? seg.minus)!.side]}侧`;
    lines.push(`- ${seg.id} ${seg.kind === 'shared' ? '共用墙' : '外墙'}(${owner}) 长${seg.end - seg.start} 厚${seg.thickness} 高${seg.height}${seg.open ? ' 已开放(无墙)' : ''}`);
  }

  if (design.openings.length) {
    lines.push('门窗（挂在持有房间的某条边上，offset 从该边参考端量起：上/左边从左/上端，下/右边从左/上端）:');
    for (const o of design.openings) lines.push(`- ${fmtOpening(design, o)}`);
  }
  return lines.join('\n');
}
