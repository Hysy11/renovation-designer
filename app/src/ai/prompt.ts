// 系统提示词与工具定义（方案 10.2、10.3）。
// 工具参数用“扁平结构”描述（op + 目标 + 字段对象），严格检查由引擎完成；
// 提示词里写入坐标定义、指令说明与例子、家具目录、风格预设、设计快照与当前状态。
import type { Design } from '../model/schema';
import { TEMPLATES } from '../catalog/furniture';
import { STYLE_PRESETS } from '../catalog/styles';
import { USAGE_LABEL } from '../catalog/labels';
import { designSnapshot } from './snapshot';

export const TOOL_PROPOSE = 'propose_design_changes';
export const TOOL_VIEW = 'view_action';

/** 发给厂商的 tools 字段（OpenAI 格式；不发送 tool_choice，方案 10.1） */
export function toolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_PROPOSE,
        description: '提出一组设计修改。修改只是“试看”，用户确认应用后才写入设计；不能用于回答问题或操作视角。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '一句话说明这组修改想达到什么效果' },
            ops: {
              type: 'array',
              minItems: 1,
              description: '修改指令列表，按顺序执行；新增对象用临时编号 new:xxx，后续指令可直接引用',
              items: { type: 'object' },
            },
          },
          required: ['summary', 'ops'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: TOOL_VIEW,
        description: '操作视角或界面，不改变设计。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['focus_room', 'top_view', 'reset_view', 'highlight', 'switch_page', 'toggle_cutaway'],
              description: 'focus_room 聚焦某间房（target 传 "house" 回到全屋取景）、top_view 俯视、reset_view 恢复默认视角、highlight 高亮对象、switch_page 切换页面、toggle_cutaway 切换剖面',
            },
            target: { type: 'string', description: '对象编号：focus_room 传房间 id、名称或 "house"（全屋）；highlight 传房间或对象 id；switch_page 传 plan 或 3d' },
          },
          required: ['action'],
        },
      },
    },
  ];
}

const RULES = `你是一个室内设计助手，帮助用户调整户型和家具。你必须遵守：

1. 修改设计只能调用 propose_design_changes 工具提交修改指令，由本地程序检查后生成“试看”。绝不改用文字假装已经修改；在试看被用户应用之前，一切修改都尚未生效。
2. 视角、切页等用 view_action 工具，它不会改变设计。
3. 回答问题（面积、能不能放下、尺寸换算等）直接用文字，不调用工具。
4. 用户意图不明确时先提问确认，不要猜着大改；不要擅自重做全屋。
5. 修改指令会被严格检查，任何错误都会返回给你：按错误说明修正后可以重新提交。
6. 一次只提交一份修改提议，不要在一次回复里调用多次 propose_design_changes。
7. 用户附带图片时：先看图再行动。户型图识别只产出房间与门窗的初稿（尺寸优先读图上标注，无标注时按比例估算）；家具只能映射到内置家具模板，没有相近模板就说明做不到；风格参考只改风格参数（颜色、材质、灯光），不动几何、不增删家具。识别结果同样走试看，不承诺精确一致的还原。`;

const COORDS = `坐标与尺寸定义（全站统一，单位毫米，整数）：
- 平面坐标原点在画布左上；x 向右为正，y 向下为正。“左”= x 减小，“右”= x 增大，“上”= y 减小，“下”= y 增大。
- 房间矩形 x,y 是左上角；length 沿 x（左右），width 沿 y（上下）；四条边就是四面墙的中心线（轴线尺寸）。
- 家具 cx,cy 是家具底面中心在画布上的绝对坐标（不是相对房间）；elevation 是离地高度。
- 家具朝向 rotation 单位为度，0° 表示正面朝下（+y），顺时针为正，取值 0–359。
- 墙参考端：上、下边从左端量起；左、右边从上端量起。门窗 offset 是洞口起点到参考端的距离。
- 平面 x 对应 3D X，平面 y 对应 3D Z，高度对应 Y，1 单位 = 1 米。`;

const OPS_DOC = `修改指令（ops 数组的每一项，扁平结构）：

房间：
- {op:"room.add", tempId:"new:r1", room:{name:"书房", usage:"other", x, y, length, width}}
  usage 只能是 living/bedroom/kitchen/bathroom/balcony/other 之一（书房等用 other）。
- {op:"room.update", id:"房间id", set:{length:6000}, add:{x:-300}}   set 是设为某值，add 是在原值上加减。
- {op:"room.remove", id:"房间id"}

墙（编号见设计快照的墙段列表）：
- {op:"wall.update", id:"ext:房间id:top", set:{thickness:240, open:true}}}   open:true 表示这段不建墙。
  set 里某字段为 null 表示恢复默认值。

门窗：
- {op:"opening.add", tempId:"new:d1", opening:{kind:"door"或"window", hostRoomId, side:"top/right/bottom/left", offset, width, height, sill}}
  门：use:"entry"或"interior"，openMode:"swing"（铰链 hinge:"start"/"end"，开向 swingInto:"host"/"other"）、"sliding"（slideTo:"start"/"end"）或 "none"；入户门只能在外墙上。
  窗：windowType:"floor"或"standard"；sill 是窗台离地高度，门恒为 0。
- {op:"opening.update", id, set:{offset:500}, add:{width:100}}
- {op:"opening.remove", id}

家具（模板目录见下方）：
- {op:"furniture.add", tempId:"new:f1", furniture:{templateId:"sofa.3seat", roomId, cx, cy, rotation}}
  cx,cy 是画布绝对坐标；l,w,h,elevation,name 可省略（用模板默认）。
- {op:"furniture.update", id, set:{cx:5200, rotation:90}, add:{cx:-200}}
  “沙发左移 20 厘米”写成 add:{cx:-200}，不要自己算新坐标。
- {op:"furniture.remove", id}

风格与全局：
- {op:"style.update", set:{palette:{wallColor:"#F7F5F0"}, floor:{material:"wood-floor", color:"#C8A47C"}, lighting:{colorTemp:4000, intensity:1.0}}}
- {op:"style.applyPreset", presetId:"cozy-light-wood"或"mid-century-minimal", overrideAll:true}
- {op:"display.update", set:{base:{height:200}}}   展示基座。
- {op:"design.update", set:{name:"我的家"}}   设计名称。

要点：新增对象的 tempId 用 new:名字，同一批后面的指令直接引用它；一批指令要么全部合法、要么整体不生效，相关的修改放在一批里。`;

const EXAMPLES = `示例：
- “客厅加宽 30 厘米” → ops:[{op:"room.update", id:"<客厅id>", add:{length:300}}]
- “沙发往左挪 20 厘米” → ops:[{op:"furniture.update", id:"<沙发id>", add:{cx:-200}}]
- “卧室加一张双人床靠上墙居中” → ops:[{op:"furniture.add", tempId:"new:bed", furniture:{templateId:"bed.double", roomId:"<卧室id>", cx:<卧室中心x>, cy:<卧室y+墙厚/2+1000>, rotation:180}}]（床头贴上墙时 rotation:180，正面朝下墙）
- “客厅和阳台之间开个 1500 宽的门洞” → 先在墙段列表里找两间房之间的共用墙 id，ops:[{op:"opening.add", tempId:"new:door", opening:{kind:"door", hostRoomId:"<客厅id>", side:"bottom", offset:1000, width:1500, height:2100, sill:0, use:"interior", openMode:"none"}}]
- “整体换成简约中古风” → ops:[{op:"style.applyPreset", presetId:"mid-century-minimal"}]`;

function furnitureCatalog(): string {
  const byCat = new Map<string, string[]>();
  for (const t of TEMPLATES) {
    const line = `${t.id} ${t.name} ${t.size.l}×${t.size.w}×${t.size.h}（尺寸范围 长${t.range.l[0]}–${t.range.l[1]} 宽${t.range.w[0]}–${t.range.w[1]} 高${t.range.h[0]}–${t.range.h[1]}）`;
    const list = byCat.get(t.category) ?? [];
    list.push(line);
    byCat.set(t.category, list);
  }
  return [...byCat.entries()].map(([cat, list]) => `${cat}：\n  ${list.join('\n  ')}`).join('\n');
}

const USAGE_LINE = Object.values(USAGE_LABEL).join('/');

export interface PromptContext {
  design: Design;
  /** 当前选中对象（如 "room:r_01"），没有则空 */
  selection?: string | null;
  page?: 'plan' | '3d';
  mode?: 'preview' | 'edit';
  /** 正在试看的方案（继续调整时，模型需要知道要保留什么） */
  trial?: { summary: string; opsJson: string } | null;
  /** 上一份试看的处理结果（已应用/已放弃/已过期），程序生成 */
  lastTrialOutcome?: string | null;
  /** 该厂商是否支持图片输入（决定提示词里怎么说图片） */
  supportsImages?: boolean;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = [];
  parts.push(RULES);
  parts.push(COORDS);
  parts.push(`房间用途（usage）可选值：${USAGE_LINE}。`);
  parts.push(OPS_DOC);
  parts.push(EXAMPLES);
  parts.push(`内置家具模板目录（templateId，家具只能从这里选）：\n${furnitureCatalog()}`);
  const presets = Object.entries(STYLE_PRESETS).map(([id, p]) => `${id} ${p.name}`).join('；');
  parts.push(`风格预设（presetId）：${presets}。用户单独改过的颜色在使用预设时默认保留。`);
  if (ctx.supportsImages) {
    parts.push('用户可以附带图片。看图时优先读图上的尺寸标注；没有标注时按常见家具尺寸和门宽估算，并在 summary 里说明是估算。');
  }
  parts.push(`当前设计快照（真实数据，以此为准）：\n${designSnapshot(ctx.design, ctx.selection?.startsWith('room:') ? ctx.selection.slice(5) : null)}`);
  const state: string[] = [];
  state.push(`当前页面：${ctx.page === '3d' ? '3D' : '平面图'}；模式：${ctx.mode === 'edit' ? '编辑' : '预览'}`);
  state.push(ctx.selection ? `选中对象：${ctx.selection}` : '没有选中对象');
  if (ctx.trial) {
    parts.push(
      `当前正在试看一份修改方案「${ctx.trial.summary || '（无说明）'}」，它尚未应用。用户继续提出的修改会**整体替换**这份试看（不是在其上叠加）：` +
      `如果新方案需要保留下面这些改动，请把它们包含进新的指令里。当前试看的指令：\n${ctx.trial.opsJson}`,
    );
  } else {
    parts.push('当前没有试看方案。历史里出现过的试看都已应用、放弃或过期；应用后被撤销的修改也已整体还原——不要把历史里的试看当成尚未生效的修改，一切以设计快照为准。');
  }
  if (ctx.lastTrialOutcome) state.push(`上一份试看的结果：${ctx.lastTrialOutcome}`);
  parts.push(`当前状态：${state.join('；')}。`);
  return parts.join('\n\n');
}
