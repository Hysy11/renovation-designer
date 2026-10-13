// 家具和门窗在平面图上的符号（方案 11.1 节）。只管画，不含交互。
import type { FurnitureTemplate } from '../catalog/furniture';
import type { Opening } from '../model/schema';
import type { OpeningGeom } from './transform';
import { swingDoorPath } from './transform';

/**
 * 家具符号：在“局部坐标系”里画——中心在 (0,0)，x 轴是长（l），y 轴是宽（w），正面朝 +y。
 * 画布外面套 transform 放到世界位置和角度。
 */
export function FurnitureSymbol({ kind, l, w, sw }: { kind: FurnitureTemplate['planSymbol']; l: number; w: number; sw: number }) {
  const hl = l / 2, hw = w / 2;
  const line = (x1: number, y1: number, x2: number, y2: number, key: string) => (
    <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={sw} stroke="currentColor" fill="none" />
  );
  const rect = (x: number, y: number, width: number, height: number, key: string, fill?: string, dashed?: boolean) => (
    <rect key={key} x={x} y={y} width={width} height={height} rx={Math.min(60, width / 8, height / 8)}
      stroke="currentColor" strokeWidth={sw} fill={fill ?? 'none'} strokeDasharray={dashed ? `${sw * 3} ${sw * 2}` : undefined} />
  );
  const front = (key: string) => (
    <path key={key} d={`M ${-l * 0.06} ${hw} L 0 ${hw + Math.min(150, w * 0.12)} L ${l * 0.06} ${hw} Z`} fill="currentColor" />
  );

  switch (kind) {
    case 'bed': // 床：外框 + 靠头带 + 被子折线；床头在 -y
      return (
        <g>
          {rect(-hl, -hw, l, w, 'b')}
          {line(-hl, -hw + w * 0.18, hl, -hw + w * 0.18, 'p')}
          {line(-hl, hw - w * 0.12, hl, hw - w * 0.12, 'f')}
          {line(0, -hw + w * 0.18, 0, hw - w * 0.12, 'm')}
        </g>
      );
    case 'wardrobe': // 衣柜：外框 + 挂衣杆线
      return <g>{rect(-hl, -hw, l, w, 'b')}{line(-hl + l * 0.08, -hw + w * 0.3, hl - l * 0.08, -hw + w * 0.3, 'r')}</g>;
    case 'sofa': { // 沙发：靠背（-y）+ 两扶手 + 坐垫
      const back = w * 0.22, arm = l * 0.1;
      return (
        <g>
          {rect(-hl, -hw, l, w, 'b')}
          {rect(-hl, -hw, l, back, 'k')}
          {rect(-hl, -hw, arm, w, 'a1')}
          {rect(hl - arm, -hw, arm, w, 'a2')}
          {rect(-hl + arm, -hw + back, l - arm * 2, w - back, 's')}
        </g>
      );
    }
    case 'table':
      return <g>{rect(-hl, -hw, l, w, 't')}</g>;
    case 'cabinet': // 柜类：外框 + 内缩线
      return <g>{rect(-hl, -hw, l, w, 'b')}{rect(-hl + l * 0.12, -hw + w * 0.12, l * 0.76, w * 0.76, 'i')}</g>;
    case 'chair': { // 椅：座面 + 靠背（-y）
      const back = w * 0.18;
      return <g>{rect(-hl, -hw + back, l, w - back, 's')}{rect(-hl, -hw, l, back, 'k')}</g>;
    }
    case 'desk':
      return <g>{rect(-hl, -hw, l, w, 'b')}{line(-hl, -hw + w * 0.16, hl, -hw + w * 0.16, 'e')}</g>;
    case 'counter': // 橱柜台面：外框 + 靠墙挡水线
      return <g>{rect(-hl, -hw, l, w, 'b')}{line(-hl, -hw + w * 0.1, hl, -hw + w * 0.1, 'e')}</g>;
    case 'rug':
      return <g>{rect(-hl, -hw, l, w, 'r', undefined, true)}</g>;
  }
}

/**
 * 门窗符号。洞口矩形（墙面上的缺口）由画布先铺底色，这里画洞里的图形。
 * sideSign：开启弧朝哪一侧（h 墙 +1 是下方），由 swingInto 和持有方向换算。
 */
export function OpeningSymbol({ o, g, leafColor, frameColor }: {
  o: Opening; g: OpeningGeom; leafColor: string; frameColor: string;
}) {
  const along = (a: number, off: number): [number, number, number, number] =>
    g.orientation === 'h' ? [a, g.line + off, a, g.line] : [g.line + off, a, g.line, a];
  const w = g.end - g.start;

  if (o.kind === 'window') {
    // 窗：贴墙两线 + 中线（三线符号）
    const inset = Math.min(30, g.t / 8);
    const lines: [number, number, number, number][] = [
      along(g.start, g.t / 2 - inset), along(g.end, g.t / 2 - inset),
      along(g.start, -g.t / 2 + inset), along(g.end, -g.t / 2 + inset),
      along(g.start, 0), along(g.end, 0),
    ];
    return (
      <g>
        {lines.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={frameColor} strokeWidth={Math.max(g.t * 0.06, 12)} />
        ))}
      </g>
    );
  }

  if (o.openMode === 'sliding') {
    // 移门：半宽门扇停在滑动方向一侧 + 滑动箭头
    const leafLen = w / 2;
    const x0 = o.slideTo === 'end' ? g.end - leafLen : g.start;
    const leaf = g.orientation === 'h'
      ? { x: x0, y: g.line - g.t * 0.15, w: leafLen, h: g.t * 0.3 }
      : { x: g.line - g.t * 0.15, y: x0, w: g.t * 0.3, h: leafLen };
    const c = g.orientation === 'h' ? { x: (g.start + g.end) / 2, y: g.line } : { x: g.line, y: (g.start + g.end) / 2 };
    const dir = o.slideTo === 'end' ? 1 : -1;
    const [ax1, ay1, ax2, ay2] = g.orientation === 'h'
      ? [c.x, c.y, c.x + dir * leafLen * 0.7, c.y]
      : [c.x, c.y, c.x, c.y + dir * leafLen * 0.7];
    return (
      <g>
        <rect x={leaf.x} y={leaf.y} width={leaf.w} height={leaf.h} fill={leafColor} stroke="none" />
        <line x1={ax1} y1={ay1} x2={ax2} y2={ay2} stroke={frameColor} strokeWidth={Math.max(g.t * 0.07, 14)} />
      </g>
    );
  }

  if (o.openMode === 'none') {
    // 无门扇：只留洞口（画两个门框短线）
    return (
      <g>
        {[g.start, g.end].map((a, i) => {
          const [x1, y1, x2, y2] = along(a, 0);
          const off = g.orientation === 'h' ? [x1, y1 - g.t / 2, x1, y1 + g.t / 2] : [x1 - g.t / 2, y1, x1 + g.t / 2, y1];
          return <line key={i} x1={off[0]} y1={off[1]} x2={off[2]} y2={off[3]} stroke={frameColor} strokeWidth={Math.max(g.t * 0.07, 14)} />;
        })}
      </g>
    );
  }

  // 平开门：门扇 + 开启弧
  const sideSign: 1 | -1 = (o.swingInto === 'host' ? g.hostSign : -g.hostSign) as 1 | -1;
  return (
    <g>
      <path d={swingDoorPath(g, o.hinge ?? 'start', sideSign)} fill={leafColor} fillOpacity={0.55}
        stroke={frameColor} strokeWidth={Math.max(g.t * 0.05, 10)} strokeLinejoin="round" />
    </g>
  );
}
