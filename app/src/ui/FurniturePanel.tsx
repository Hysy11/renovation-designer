// 家具模板面板（方案 11.2）：家具维度下未选中对象时显示。点模板→点房间放置。
import { getTemplate, TEMPLATES, type FurnitureTemplate } from '../catalog/furniture';
import { FurnitureSymbol } from '../plan/PlanSymbols';

export function FurniturePanel({ armed, onArm }: { armed: string | null; onArm: (id: string | null) => void }) {
  const byCategory = new Map<string, FurnitureTemplate[]>();
  for (const t of TEMPLATES) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }
  return (
    <div>
      <div style={hintStyle}>点一个家具模板，再点画布上的房间放置；Esc 取消。</div>
      {[...byCategory.entries()].map(([cat, list]) => (
        <section key={cat} style={{ marginBottom: 14 }}>
          <div style={catStyle}>{cat}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {list.map((t) => {
              const active = armed === t.id;
              return (
                <button key={t.id} onClick={() => onArm(active ? null : t.id)} style={cell(active)} title={`${t.name}（默认 ${t.size.l}×${t.size.w}×${t.size.h} mm）`}>
                  <svg width={44} height={32} viewBox="-1300 -950 2600 1900" style={{ display: 'block' }}>
                    <g color="#6B6459">
                      <FurnitureSymbol kind={t.planSymbol} l={t.size.l} w={t.size.w} sw={14} />
                    </g>
                  </svg>
                  <span>{t.name}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {armed && (
        <div style={{ ...hintStyle, color: '#3E7BB6' }}>
          已选「{getTemplate(armed)?.name}」，点击房间内放置
        </div>
      )}
    </div>
  );
}

const hintStyle: React.CSSProperties = { fontSize: 12, color: '#8A8172', lineHeight: 1.7, marginBottom: 12 };
const catStyle: React.CSSProperties = { fontSize: 12, color: '#8A8172', margin: '8px 0 6px' };

function cell(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2,
    padding: '6px 8px', borderRadius: 8, border: `1px solid ${active ? '#3E7BB6' : '#DDD6C8'}`,
    background: active ? '#E3EDF7' : '#fff', color: '#5A5245', fontSize: 11.5, cursor: 'pointer',
  };
}
