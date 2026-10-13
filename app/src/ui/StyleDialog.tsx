// 风格设置界面（需求 STYLE-01～08）：
// 预设卡片（温馨浅木 / 简约中古风）+ 全字段自定义（主色/辅助色/点缀色/墙面/木色/金属/织物、地面材质、灯光色温与亮度）。
// 应用一律走试看（STYLE-05）；默认保留对象上单独改过的外观，勾选“覆盖所有兼容对象”才批量清除（STYLE-06）。
import { useState } from 'react';
import { actions, getStore } from './useApp';
import { displayDesign } from '../store/designStore';
import { STYLE_PRESETS, DEFAULT_PRESET } from '../catalog/styles';
import { FLOOR_MATERIALS, type Palette, type Style } from '../model/schema';
import { FLOOR_LABEL } from '../catalog/labels';
import type { Op } from '../engine/ops';

const COLOR_FIELDS: { key: keyof Palette; label: string }[] = [
  { key: 'primary', label: '主色' },
  { key: 'secondary', label: '辅助色' },
  { key: 'accent', label: '点缀色' },
  { key: 'wallColor', label: '墙面颜色' },
  { key: 'woodColor', label: '默认木色' },
  { key: 'metalColor', label: '金属色' },
  { key: 'fabricColor', label: '织物色' },
];

const btn = (primary = false): React.CSSProperties => ({
  border: `1px solid ${primary ? '#C25B4E' : '#D8D2C4'}`, background: primary ? '#C25B4E' : '#fff',
  color: primary ? '#fff' : '#5A5245', borderRadius: 8, padding: '6px 16px', fontSize: 12.5, cursor: 'pointer',
});
const fieldLabel: React.CSSProperties = { fontSize: 12, color: '#8A8172', margin: '10px 0 3px' };

interface Props {
  onClose: () => void;
  onNotice: (text: string, level?: 'info' | 'error') => void;
}

export function StyleDialog({ onClose, onNotice }: Props) {
  const store = getStore().getState();
  const overlay = store.session.overlay;
  // 风格试看进行中重开本窗口＝“继续调整”（TRY-03）：提交时替换当前试看而不是另开一个
  const inStyleTrial = overlay.type === 'trial' && overlay.source === 'style';
  const current = store.design.style; // 真实设计的风格；差异以它为基准，试看候选只作初始草稿
  const [draft, setDraft] = useState<Style>(() => structuredClone(displayDesign(store).style));
  const [overrideAll, setOverrideAll] = useState(false); // STYLE-06：默认保留单独外观

  const setColor = (key: keyof Palette, value: string) =>
    setDraft((d) => ({ ...d, palette: { ...d.palette, [key]: value } }));
  const setMaterial = (value: Style['floor']['material']) =>
    setDraft((d) => ({ ...d, floor: { ...d.floor, material: value } }));

  const applyTrial = (ops: Op[], summary: string) => {
    const r = inStyleTrial ? actions().reviseTrial(ops, summary) : actions().startTrial('style', ops, summary);
    if (!r.ok) { onNotice(r.message, 'error'); return; }
    onNotice(`${inStyleTrial ? '试看已更新' : '试看中'}：${summary}，确认后点横幅上的“应用”`);
    onClose();
  };

  /** 切换预设：整份风格换成预设；勾选覆盖时同时清除对象单独设置的颜色与地面（STYLE-06） */
  const applyPreset = (id: keyof typeof STYLE_PRESETS) => {
    applyTrial([{ op: 'style.applyPreset', presetId: id, ...(overrideAll ? { overrideAll: true } : {}) }],
      `切换为「${STYLE_PRESETS[id].name}」`);
  };

  /** 应用自定义：只提交改过的字段。勾选覆盖时先按底子预设清一遍对象外观，再叠加自定义值 */
  const applyCustom = () => {
    const palette: Partial<Palette> = {};
    for (const { key } of COLOR_FIELDS) if (draft.palette[key] !== current.palette[key]) palette[key] = draft.palette[key];
    const set: NonNullable<Extract<Op, { op: 'style.update' }>['set']> = {};
    if (Object.keys(palette).length) set.palette = palette;
    if (draft.floor.material !== current.floor.material) set.floor = { material: draft.floor.material };
    if (draft.lighting.colorTemp !== current.lighting.colorTemp || draft.lighting.intensity !== current.lighting.intensity)
      set.lighting = { colorTemp: draft.lighting.colorTemp, intensity: draft.lighting.intensity };
    if (!Object.keys(set).length) { onNotice('没有改动任何风格字段'); return; }
    const ops: Op[] = [];
    if (overrideAll)
      ops.push({ op: 'style.applyPreset', presetId: current.presetId === 'mid-century-minimal' ? 'mid-century-minimal' : DEFAULT_PRESET, overrideAll: true });
    ops.push({ op: 'style.update', set });
    applyTrial(ops, '自定义风格调整');
  };

  const num = (v: string, fallback: number) => {
    const t = v.trim();
    if (!t) return fallback; // 清空输入框时保持原值，不落到下限（Number('') 是 0）
    const n = Number(t);
    return Number.isFinite(n) ? n : fallback;
  };
  // 与 geometry/validate 的 LIMITS 一致；输入越界直接夹回范围，避免试看时才报错
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(40,35,25,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="style-dialog">
      <div style={{ width: 480, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto', background: '#FBF8F1', borderRadius: 14, border: '1px solid #D8D2C4', boxShadow: '0 12px 40px rgba(40,35,25,.25)', padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <strong style={{ fontSize: 14, flex: 1 }}>风格设置</strong>
          <button onClick={onClose} style={btn()} title="关闭">✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#8A8172', lineHeight: 1.7 }}>
          切换预设或应用自定义都先试看，点横幅上的“应用”才写入，可一次撤销；不改房间尺寸、门窗位置和家具摆放（STYLE-04）。
        </div>

        {/* 预设卡片（STYLE-01） */}
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          {(Object.keys(STYLE_PRESETS) as (keyof typeof STYLE_PRESETS)[]).map((id) => {
            const p = STYLE_PRESETS[id];
            const isCurrent = current.presetId === id;
            return (
              <div key={id} style={{
                flex: 1, border: `1px solid ${isCurrent ? '#C25B4E' : '#D8D2C4'}`, borderRadius: 10,
                padding: '10px 12px', background: isCurrent ? '#FBEDEB' : '#fff',
              }}>
                <div style={{ fontSize: 13, color: '#3A342B', fontWeight: 600 }}>
                  {p.name}{isCurrent && <span style={{ fontSize: 11, color: '#C25B4E', fontWeight: 400 }}>（当前）</span>}
                </div>
                <div style={{ display: 'flex', gap: 4, margin: '8px 0' }}>
                  {[p.style.palette.wallColor, p.style.palette.primary, p.style.palette.woodColor, p.style.palette.accent, p.style.palette.metalColor].map((c, i) => (
                    <span key={i} style={{ width: 18, height: 18, borderRadius: 4, background: c, border: '1px solid #00000018' }} />
                  ))}
                </div>
                <button onClick={() => applyPreset(id)} style={{ ...btn(id !== 'mid-century-minimal'), width: '100%', marginTop: 4 }}>
                  {isCurrent ? '重新应用' : '试看此风格'}
                </button>
              </div>
            );
          })}
        </div>

        {/* 覆盖开关（STYLE-06） */}
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '14px 2px 0', fontSize: 12, color: '#5A5245', cursor: 'pointer', lineHeight: 1.6 }}>
          <input type="checkbox" checked={overrideAll} onChange={(e) => setOverrideAll(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            覆盖所有兼容对象：把房间地面、墙面颜色、门窗颜色和家具部件上<b>单独改过</b>的外观也统一清掉，全部跟随新风格。
            <br /><span style={{ color: '#8A8172' }}>默认不勾：这些单独设置会保留。家具材质不属于风格，始终保留。</span>
          </span>
        </label>

        {/* 自定义字段（STYLE-03） */}
        <div style={fieldLabel}>自定义（在当前风格基础上改，改完点下方按钮试看）</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 14px', marginTop: 4 }}>
          {COLOR_FIELDS.map(({ key, label }) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5A5245' }}>
              <input type="color" value={draft.palette[key]} onChange={(e) => setColor(key, e.target.value)}
                style={{ width: 34, height: 26, padding: 0, border: '1px solid #D8D2C4', borderRadius: 6, background: '#fff', cursor: 'pointer' }} />
              <span style={{ flex: 1 }}>{label}</span>
              <span style={{ fontSize: 11, color: '#B0A99B' }}>{draft.palette[key]}</span>
            </label>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5A5245' }}>
            <span style={{ flex: 1 }}>地面基础材质</span>
            <select value={draft.floor.material} onChange={(e) => setMaterial(e.target.value as Style['floor']['material'])}
              style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid #D8D2C4', background: '#fff', fontSize: 12 }}>
              {FLOOR_MATERIALS.map((m) => <option key={m} value={m}>{FLOOR_LABEL[m]}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5A5245' }}>
            <span style={{ flex: 1 }}>灯光色温（K）</span>
            <input type="number" min={2700} max={6500} step={100} value={draft.lighting.colorTemp}
              onChange={(e) => setDraft((d) => ({ ...d, lighting: { ...d.lighting, colorTemp: clamp(Math.round(num(e.target.value, d.lighting.colorTemp)), 2700, 6500) } }))}
              style={{ width: 84, padding: '5px 8px', borderRadius: 8, border: '1px solid #D8D2C4', fontSize: 12 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5A5245' }}>
            <span style={{ flex: 1 }}>灯光亮度</span>
            <input type="number" min={0.5} max={1.5} step={0.05} value={draft.lighting.intensity}
              onChange={(e) => setDraft((d) => ({ ...d, lighting: { ...d.lighting, intensity: clamp(num(e.target.value, d.lighting.intensity), 0.5, 1.5) } }))}
              style={{ width: 84, padding: '5px 8px', borderRadius: 8, border: '1px solid #D8D2C4', fontSize: 12 }} />
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={applyCustom} style={btn(true)}>试看自定义风格</button>
        </div>

        <div style={{ fontSize: 11.5, color: '#8A8172', marginTop: 8, lineHeight: 1.6 }}>
          当前风格随设计自动保存、进历史版本、随项目包导出（STYLE-08）；AI 与这里用的是同一套风格字段（STYLE-07）。
        </div>
      </div>
    </div>
  );
}
