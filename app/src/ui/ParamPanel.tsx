// 参数面板（方案 11.3）：显示选中对象的名称、类型和可改项目；没选中时给操作提示。
// 输入回车或失焦提交；不合法时标红、说明原因、保持原值（EDIT-04）。
import { useEffect, useMemo, useState } from 'react';
import { actions, getStore, useApp } from './useApp';
import { displayDesign } from '../store/designStore';
import type { Design, Furniture, Opening, Room, Side } from '../model/schema';
import { SIDES } from '../model/schema';
import { deriveWalls, findHostSegment, netSize, roomEdge } from '../geometry/walls';
import { openingLabel, segmentLabel } from '../geometry/validate';
import { planRoomRemoval } from '../engine/apply';
import { getTemplate } from '../catalog/furniture';
import { FLOOR_LABEL, MATERIAL_LABEL, SIDE_LABEL, USAGE_COLOR, USAGE_LABEL } from '../catalog/labels';
import { furniturePart, wallColor } from '../engine/appearance';
import type { ConfirmSpec } from './ConfirmDialog';

export function ParamPanel({ wallKey, onConfirm }: { wallKey: string | null; onConfirm: (spec: ConfirmSpec) => void }) {
  const design = useApp(displayDesign);
  const session = useApp((s) => s.session);
  const sel = session.selection;
  const readOnly = session.mode !== 'edit' || session.overlay.type === 'history';

  const derived = useMemo(() => deriveWalls(design), [design]);

  if (!sel) {
    return (
      <div style={{ padding: '4px 2px', fontSize: 12.5, color: '#8A8172', lineHeight: 2 }}>
        <div style={hintTitle}>{session.dimension === 'room' ? '房间与墙' : '家具'}</div>
        {session.dimension === 'room' ? (
          <>
            <div>· 点工具栏「画房间」，在画布上拖出矩形</div>
            <div>· 点房间选中后可拖动、改大小</div>
            <div>· 点墙段选中后可在下方加门、窗</div>
            <div>· 方向键微调选中对象，Delete 删除</div>
          </>
        ) : (
          <>
            <div>· 从上方模板列表点选家具，再点房间放置</div>
            <div>· 点家具选中后可拖动、改大小、旋转</div>
            <div>· 方向键微调，Cmd/Ctrl+D 复制，Delete 删除</div>
          </>
        )}
      </div>
    );
  }

  if (sel.kind === 'room') {
    const room = design.rooms.find((r) => r.id === sel.id);
    if (!room) return <div style={note}>这个房间已不存在。</div>;
    return <RoomPanel key={sel.id} design={design} derived={derived} room={room} readOnly={readOnly} onConfirm={onConfirm} />;
  }
  if (sel.kind === 'wall') return <WallPanel design={design} derived={derived} selId={sel.id} wallKey={wallKey} readOnly={readOnly} />;
  if (sel.kind === 'opening') {
    const o = design.openings.find((x) => x.id === sel.id);
    if (!o) return <div style={note}>这个门窗已不存在。</div>;
    return <OpeningPanel key={sel.id} design={design} derived={derived} o={o} readOnly={readOnly} />;
  }
  const f = design.furniture.find((x) => x.id === sel.id);
  if (!f) return <div style={note}>这件家具已不存在。</div>;
  return <FurniturePanelParams key={sel.id} design={design} f={f} readOnly={readOnly} />;
}

const hintTitle: React.CSSProperties = { fontSize: 13, color: '#5A5245', fontWeight: 600, marginBottom: 6 };
const section: React.CSSProperties = { marginTop: 16, borderTop: '1px solid #EDE8DC', paddingTop: 12 };
const sectionTitle: React.CSSProperties = { fontSize: 12, color: '#8A8172', margin: '0 0 8px' };
const note: React.CSSProperties = { fontSize: 12, color: '#8A8172', lineHeight: 1.7 };

/** 提交一组指令；返回 undefined 表示成功，否则返回错误说明 */
const commit = (ops: unknown): string | undefined => {
  const r = actions().commit(ops);
  return r.ok ? undefined : r.message;
};

// ---------- 通用字段 ----------

function NumField({ label, value, disabled, commitNum, suffix }: {
  label: string; value: number; disabled?: boolean; suffix?: string;
  commitNum: (v: number) => string | undefined;
}) {
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState<string>();
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(value)); }, [value, focused]);
  const submit = () => {
    setFocused(false);
    if (text.trim() === String(value)) { setErr(undefined); return; }
    const v = Number(text.trim());
    if (!Number.isInteger(v)) { setErr('要输入整数毫米'); setText(String(value)); return; }
    const e = commitNum(v);
    setErr(e ?? undefined);
    if (e) setText(String(value));
  };
  return (
    <label style={row}>
      <span style={labelStyle}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input value={text} disabled={disabled}
          onChange={(e) => { setText(e.target.value); setErr(undefined); }}
          onFocus={() => setFocused(true)}
          onBlur={submit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={input(err)} />
        {suffix && <span style={{ fontSize: 11, color: '#8A8172' }}>{suffix}</span>}
      </span>
      {err && <span style={errStyle}>{err}</span>}
    </label>
  );
}

/** 文本字段：缓冲输入，回车或失焦才提交（EDIT-04），空值不提交 */
function TextField({ label, value, disabled, commitText, width = 150 }: {
  label: string; value: string; disabled?: boolean; width?: number;
  commitText: (v: string) => string | undefined;
}) {
  const [text, setText] = useState(value);
  const [err, setErr] = useState<string>();
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(value); }, [value, focused]);
  const submit = () => {
    setFocused(false);
    const v = text.trim();
    if (v === value) { setErr(undefined); return; }
    if (!v) { setErr('名称不能为空'); setText(value); return; }
    const e = commitText(v);
    setErr(e ?? undefined);
    if (e) setText(value);
  };
  return (
    <label style={row}>
      <span style={labelStyle}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input value={text} disabled={disabled}
          onChange={(e) => { setText(e.target.value); setErr(undefined); }}
          onFocus={() => setFocused(true)}
          onBlur={submit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={input(err)} />
        {err && <span style={{ ...errStyle, position: 'static', gridColumn: undefined, margin: 0 }}>{err}</span>}
      </span>
    </label>
  );
}

function ColorField({ label, value, disabled, commitColor, reset }: {
  label: string; value: string; disabled?: boolean;
  commitColor: (v: string) => string | undefined;
  reset?: () => void;
}) {
  const [err, setErr] = useState<string>();
  const apply = (v: string) => { const e = commitColor(v); setErr(e ?? undefined); };
  return (
    <label style={row}>
      <span style={labelStyle}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="color" value={value} disabled={disabled}
          onChange={(e) => apply(e.target.value.toUpperCase())}
          style={{ width: 34, height: 24, padding: 0, border: '1px solid #D8D2C4', borderRadius: 6, background: '#fff', cursor: disabled ? 'default' : 'pointer' }} />
        {reset && !disabled && <button onClick={reset} style={miniBtn}>恢复默认</button>}
      </span>
      {err && <span style={errStyle}>{err}</span>}
    </label>
  );
}

function SelectField<T extends string>({ label, value, options, disabled, commitSel }: {
  label: string; value: T; options: { v: T; t: string }[]; disabled?: boolean;
  commitSel: (v: T) => string | undefined;
}) {
  const [err, setErr] = useState<string>();
  return (
    <label style={row}>
      <span style={labelStyle}>{label}</span>
      <select value={value} disabled={disabled}
        onChange={(e) => { const r = commitSel(e.target.value as T); setErr(r ?? undefined); }}
        style={{ ...input(), width: 130, cursor: 'pointer' }}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
      </select>
      {err && <span style={errStyle}>{err}</span>}
    </label>
  );
}

const row: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '88px 1fr', alignItems: 'center',
  gap: 8, marginBottom: 8, fontSize: 12.5, color: '#5A5245',
};
const labelStyle: React.CSSProperties = { color: '#8A8172' };
const input = (err?: string): React.CSSProperties => ({
  width: 96, padding: '4px 8px', borderRadius: 6, fontSize: 12.5,
  border: `1px solid ${err ? '#C0392B' : '#D8D2C4'}`, background: err ? '#FBEDEB' : '#fff',
  color: '#3A342B', outline: 'none',
});
const errStyle: React.CSSProperties = { gridColumn: '2', fontSize: 11, color: '#C0392B', lineHeight: 1.5, marginTop: -4, marginBottom: 6 };
const miniBtn: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #D8D2C4',
  background: '#fff', color: '#8A8172', cursor: 'pointer',
};
const dangerBtn: React.CSSProperties = {
  ...miniBtn, color: '#C25B4E', borderColor: '#E4C4BE', padding: '5px 12px',
};

// ---------- 房间 ----------

function RoomPanel({ design, derived, room, readOnly, onConfirm }: {
  design: Design; derived: ReturnType<typeof deriveWalls>; room: Room; readOnly: boolean; onConfirm: (spec: ConfirmSpec) => void;
}) {
  const net = netSize(room, derived);
  const wallPatch = (side: Side, v: string | null) =>
    commit([{ op: 'room.update', id: room.id, set: { wallColors: { [side]: v } } }]);
  const floorPatch = (patch: { color?: string; material?: string } | null) =>
    commit([{ op: 'room.update', id: room.id, set: { floor: patch } }]);

  const [rmErr, setRmErr] = useState<string>();
  const askRemove = () => onConfirm(roomRemovalSpec(design, room.id, setRmErr));

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#3A342B' }}>房间「{room.name}」</div>
      <div style={note}>编号 {room.id}</div>

      <div style={section}>
        <TextField label="名称" value={room.name} disabled={readOnly}
          commitText={(v) => commit([{ op: 'room.update', id: room.id, set: { name: v } }])} />
        <SelectField label="用途" value={room.usage} disabled={readOnly}
          options={Object.entries(USAGE_LABEL).map(([v, t]) => ({ v: v as Room['usage'], t }))}
          commitSel={(v) => commit([{ op: 'room.update', id: room.id, set: { usage: v, planColor: USAGE_COLOR[v] } }])} />
        <NumField label="长（左右）" value={room.length} disabled={readOnly}
          commitNum={(v) => commit([{ op: 'room.update', id: room.id, set: { length: v } }])} suffix="mm" />
        <NumField label="宽（上下）" value={room.width} disabled={readOnly}
          commitNum={(v) => commit([{ op: 'room.update', id: room.id, set: { width: v } }])} suffix="mm" />
        <NumField label="X 位置" value={room.x} disabled={readOnly}
          commitNum={(v) => commit([{ op: 'room.update', id: room.id, set: { x: v } }])} suffix="mm" />
        <NumField label="Y 位置" value={room.y} disabled={readOnly}
          commitNum={(v) => commit([{ op: 'room.update', id: room.id, set: { y: v } }])} suffix="mm" />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
          <DirectionDiagram />
          <div style={note}>
            室内净尺寸（参考）<br />
            <b>{net.length} × {net.width} mm</b><br />
            长宽为轴线尺寸，净尺寸已扣除墙厚
          </div>
        </div>
      </div>

      <div style={section}>
        <div style={sectionTitle}>颜色</div>
        <ColorField label="平面底色" value={room.planColor} disabled={readOnly}
          commitColor={(v) => commit([{ op: 'room.update', id: room.id, set: { planColor: v } }])} />
        <SelectField label="地板" value={design.style.floor.material} disabled={readOnly}
          options={Object.entries(FLOOR_LABEL).map(([v, t]) => ({ v: v as Design['style']['floor']['material'], t }))}
          commitSel={(v) => floorPatch({ material: v })} />
        <ColorField label="地板颜色" value={design.style.floor.color} disabled={readOnly}
          commitColor={(v) => floorPatch({ color: v })} reset={() => floorPatch(null)} />
        {SIDES.map((side) => (
          <ColorField key={side} label={`${SIDE_LABEL[side]}墙（本面）`} value={wallColor(design, room, side)} disabled={readOnly}
            commitColor={(v) => wallPatch(side, v)}
            reset={() => wallPatch(side, null)} />
        ))}
        <div style={note}>外墙朝外的一面统一用风格墙面色。</div>
      </div>

      {!readOnly && (
        <div style={section}>
          <button onClick={askRemove} style={dangerBtn}>删除房间…</button>
          {rmErr && <div style={{ ...errStyle, gridColumn: undefined, marginTop: 6 }}>{rmErr}</div>}
        </div>
      )}
    </div>
  );
}

/** 删除房间的确认框内容（EDIT-05）：参数面板按钮和 Delete 键两个入口共用同一份话术 */
export function roomRemovalSpec(design: Design, roomId: string, onFail?: (message: string) => void): ConfirmSpec {
  const room = design.rooms.find((r) => r.id === roomId);
  const plan = planRoomRemoval(design, roomId);
  const transfers = plan.transferred.map((t) => {
    const o = design.openings.find((x) => x.id === t.openingId);
    const to = design.rooms.find((r) => r.id === t.toRoomId);
    return o && to ? `${openingLabel(design, o)}（与隔壁共用）将改由房间「${to.name}」持有并保留` : '';
  });
  return {
    title: `删除房间「${room?.name ?? roomId}」？`,
    lines: [
      '删除后可按 Cmd/Ctrl+Z 撤销。',
      `将同时删除：家具 ${plan.furniture.length} 件、门窗 ${plan.removedOpenings.length} 个`,
      ...transfers,
    ],
    onConfirm: () => {
      // VER-02：删除房间前先自动保存一个历史版本（用户取消备份则不删除）
      void actions().commitWithBackup([{ op: 'room.remove', id: roomId }], '删除房间前')
        .then((e) => { if (!e.ok) onFail?.(e.message); });
    },
  };
}

/** 方向示意（ROOM-02）：一个小房间里标出长和宽的方向 */
function DirectionDiagram() {
  return (
    <svg width={92} height={72} viewBox="0 0 92 72" style={{ flexShrink: 0 }}>
      <rect x={16} y={12} width={60} height={44} fill="#F3F0EA" stroke="#C6BFB1" />
      <line x1={22} y1={62} x2={70} y2={62} stroke="#3E7BB6" strokeWidth={1.5} markerEnd="url(#arr)" markerStart="url(#arr)" />
      <text x={46} y={70} textAnchor="middle" fontSize={10} fill="#3E7BB6">长 →</text>
      <line x1={10} y1={18} x2={10} y2={50} stroke="#3E7BB6" strokeWidth={1.5} markerEnd="url(#arr)" markerStart="url(#arr)" />
      <text x={10} y={10} textAnchor="middle" fontSize={10} fill="#3E7BB6">宽</text>
      <defs>
        <marker id="arr" viewBox="0 0 8 8" refX={4} refY={4} markerWidth={6} markerHeight={6} orient="auto">
          <path d="M 1 1 L 7 4 L 1 7 z" fill="#3E7BB6" />
        </marker>
      </defs>
    </svg>
  );
}

// ---------- 墙 ----------

function WallPanel({ design, derived, selId, wallKey, readOnly }: {
  design: Design; derived: ReturnType<typeof deriveWalls>; selId: string; wallKey: string | null; readOnly: boolean;
}) {
  const [addErr, setAddErr] = useState<string>();
  const segs = derived.byId.get(selId) ?? [];
  const seg = segs.find((s) => s.key === wallKey) ?? segs[0];
  if (!seg) return <div style={note}>这面墙已不存在（房间关系变了）。</div>;
  const sideRoom = seg.plus ?? seg.minus;
  const otherRoom = seg.plus && seg.minus ? (seg.minus.roomId === sideRoom?.roomId ? seg.plus : seg.minus) : undefined;
  const host = sideRoom ? design.rooms.find((r) => r.id === sideRoom.roomId) : undefined;
  const neighbour = otherRoom ? design.rooms.find((r) => r.id === otherRoom.roomId) : undefined;
  if (!host || !sideRoom) return <div style={note}>找不到这面墙所属的房间。</div>;

  const wallSet = (patch: Record<string, unknown>) => commit([{ op: 'wall.update', id: selId, set: patch }]);
  const addOpening = (kind: 'door' | 'window') => {
    const width = kind === 'door' ? 900 : 1500;
    const edge = roomEdge(host, sideRoom.side);
    const mid = (seg.start + seg.end) / 2;
    const op = {
      op: 'opening.add',
      opening: kind === 'door'
        ? { kind, hostRoomId: host.id, side: sideRoom.side, offset: Math.round(mid - width / 2 - edge.start), width, height: 2100, sill: 0, use: 'interior', openMode: 'swing', hinge: 'start', swingInto: 'host' }
        : { kind, hostRoomId: host.id, side: sideRoom.side, offset: Math.round(mid - width / 2 - edge.start), width, height: 1500, sill: 900, windowType: 'standard' },
    };
    const err = commit([op]);
    if (!err) {
      const d = displayDesign(getStore().getState());
      const added = d.openings.at(-1);
      if (added) actions().select({ kind: 'opening', id: added.id });
    }
    return err;
  };

  const override = design.walls[selId];
  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#3A342B' }}>{segmentLabel(design, seg)}</div>
      <div style={note}>
        编号 {selId}<br />
        范围 {Math.round(seg.start)} – {Math.round(seg.end)} mm（从参考端量起）<br />
        {seg.open ? '开放边（没有墙）' : `厚度 ${seg.thickness} mm`}
      </div>

      <div style={section}>
        <div style={sectionTitle}>在这面墙上</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button disabled={readOnly} onClick={() => setAddErr(addOpening('door') ?? undefined)} style={miniBtn}>加门</button>
          <button disabled={readOnly} onClick={() => setAddErr(addOpening('window') ?? undefined)} style={miniBtn}>加窗</button>
        </div>
        {addErr && <div style={{ ...errStyle, gridColumn: undefined }}>加不上：{addErr}</div>}
        <div style={{ ...note, marginTop: 6 }}>门、窗会放在这段墙的中间，选中后可拖动微调。</div>
      </div>

      {!seg.open && (
        <div style={section}>
          <div style={sectionTitle}>墙体</div>
          <NumField label="厚度" value={override?.thickness ?? seg.thickness} disabled={readOnly}
            commitNum={(v) => wallSet({ thickness: v })} suffix="mm" />
          <NumField label="高度" value={override?.height ?? design.defaults.wallHeight} disabled={readOnly}
            commitNum={(v) => wallSet({ height: v })} suffix="mm" />
          <label style={row}>
            <span style={labelStyle}>开放</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={!!override?.open} disabled={readOnly}
                onChange={(e) => wallSet({ open: e.target.checked || null })} />
              <span style={{ fontSize: 11, color: '#8A8172' }}>勾选后这面墙不画（开放边）</span>
            </span>
          </label>
          <button disabled={readOnly} onClick={() => wallSet({ thickness: null, height: null, open: null })} style={miniBtn}>恢复默认</button>
        </div>
      )}

      <div style={section}>
        <div style={sectionTitle}>墙面颜色（WALL-03：按面区分）</div>
        <ColorField label={`「${host.name}」侧`} value={wallColor(design, host, sideRoom.side)} disabled={readOnly}
          commitColor={(v) => commit([{ op: 'room.update', id: host.id, set: { wallColors: { [sideRoom.side]: v } } }])}
          reset={() => commit([{ op: 'room.update', id: host.id, set: { wallColors: { [sideRoom.side]: null } } }])} />
        {neighbour && otherRoom && (
          <ColorField label={`「${neighbour.name}」侧`} value={wallColor(design, neighbour, otherRoom.side)} disabled={readOnly}
            commitColor={(v) => commit([{ op: 'room.update', id: neighbour.id, set: { wallColors: { [otherRoom.side]: v } } }])}
            reset={() => commit([{ op: 'room.update', id: neighbour.id, set: { wallColors: { [otherRoom.side]: null } } }])} />
        )}
        {!neighbour && <div style={note}>外墙朝外的一面跟随风格墙色。</div>}
      </div>
    </div>
  );
}

// ---------- 门窗 ----------

function OpeningPanel({ design, derived, o, readOnly }: {
  design: Design; derived: ReturnType<typeof deriveWalls>; o: Opening; readOnly: boolean;
}) {
  const host = design.rooms.find((r) => r.id === o.hostRoomId);
  const [actErr, setActErr] = useState<string>();
  if (!host) return <div style={note}>找不到这扇门窗所属的房间。</div>;
  const edge = roomEdge(host, o.side);
  const seg = findHostSegment(host.id, o.side, edge.start + o.offset, edge.start + o.offset + o.width, derived);
  const neighbour = seg?.kind === 'shared'
    ? design.rooms.find((r) => r.id === (seg.plus?.roomId === host.id ? seg.minus?.roomId : seg.plus?.roomId))
    : undefined;
  const set = (patch: Record<string, unknown>) => commit([{ op: 'opening.update', id: o.id, set: patch }]);
  const isDoor = o.kind === 'door';
  const hasLeaf = isDoor && o.openMode !== 'none';
  const maxOffset = Math.max(0, edge.end - edge.start - o.width);

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#3A342B' }}>{openingLabel(design, o)}</div>
      <div style={note}>
        编号 {o.id} · 位于「{host.name}」{SIDE_LABEL[o.side]}墙{neighbour ? `（与「${neighbour.name}」共用）` : ''}<br />
        位置从墙上标了圆点的一端量起（0 – {maxOffset} mm）
      </div>

      <div style={section}>
        <NumField label="位置" value={o.offset} disabled={readOnly} commitNum={(v) => set({ offset: v })} suffix="mm" />
        <NumField label="宽" value={o.width} disabled={readOnly} commitNum={(v) => set({ width: v })} suffix="mm" />
        <NumField label="高" value={o.height} disabled={readOnly} commitNum={(v) => set({ height: v })} suffix="mm" />
        {o.kind === 'window'
          ? <>
            <NumField label="窗台高度" value={o.sill} disabled={readOnly} commitNum={(v) => set({ sill: v })} suffix="mm" />
            <SelectField label="窗户类型" value={o.windowType ?? 'standard'} disabled={readOnly}
              options={[{ v: 'standard', t: '普通窗' }, { v: 'floor', t: '落地窗' }]}
              commitSel={(v) => set({ windowType: v })} />
          </>
          : <>
            <SelectField label="用途" value={o.use ?? 'interior'} disabled={readOnly}
              options={[{ v: 'interior', t: '室内门' }, { v: 'entry', t: '入户门' }]}
              commitSel={(v) => set({ use: v })} />
            <SelectField label="门扇" value={o.openMode ?? 'swing'} disabled={readOnly}
              options={[{ v: 'swing', t: '平开门' }, { v: 'sliding', t: '移门' }, { v: 'none', t: '无门扇' }]}
              commitSel={(v) => set(
                // 切换门扇类型时连带整理配套字段，否则残留的铰链/开向/滑向会触发“不适用”错误
                v === 'none'
                  ? { openMode: v, hinge: null, swingInto: null, slideTo: null, colors: { leaf: null } }
                  : v === 'sliding'
                    ? { openMode: v, hinge: null, swingInto: null, slideTo: o.slideTo ?? 'end' }
                    : { openMode: v, hinge: o.hinge ?? 'start', swingInto: o.swingInto ?? 'host', slideTo: null },
              )} />
            {(o.openMode ?? 'swing') === 'swing' && (
              <>
                <SelectField label="铰链在" value={o.hinge ?? 'start'} disabled={readOnly}
                  options={[{ v: 'start', t: '参考端' }, { v: 'end', t: '另一端' }]}
                  commitSel={(v) => set({ hinge: v })} />
                <SelectField label="开向" value={o.swingInto ?? 'host'} disabled={readOnly}
                  options={neighbour
                    ? [{ v: 'host', t: `「${host.name}」内` }, { v: 'other', t: `「${neighbour.name}」内` }]
                    : [{ v: 'host', t: `「${host.name}」内` }]}
                  commitSel={(v) => set({ swingInto: v })} />
              </>
            )}
            {(o.openMode ?? 'swing') === 'sliding' && (
              <SelectField label="滑向" value={o.slideTo ?? 'start'} disabled={readOnly}
                options={[{ v: 'start', t: '参考端' }, { v: 'end', t: '另一端' }]}
                commitSel={(v) => set({ slideTo: v })} />
            )}
          </>}
        <ColorField label={isDoor ? '门框' : '窗框'} value={o.colors?.frame ?? (isDoor ? design.style.palette.woodColor : design.style.palette.metalColor)}
          disabled={readOnly}
          commitColor={(v) => set({ colors: { frame: v } })}
          reset={() => set({ colors: { frame: null } })} />
        {hasLeaf && (
          <ColorField label="门扇" value={o.colors?.leaf ?? design.style.palette.woodColor} disabled={readOnly}
            commitColor={(v) => set({ colors: { leaf: v } })} reset={() => set({ colors: { leaf: null } })} />
        )}
      </div>

      {!readOnly && (
        <div style={section}>
          <button onClick={() => { const e = commit([{ op: 'opening.remove', id: o.id }]); setActErr(e ?? undefined); }} style={dangerBtn}>
            删除{isDoor ? '门' : '窗'}
          </button>
          {actErr && <div style={{ ...errStyle, gridColumn: undefined }}>{actErr}</div>}
        </div>
      )}
    </div>
  );
}

// ---------- 家具 ----------

function FurniturePanelParams({ design, f, readOnly }: { design: Design; f: Furniture; readOnly: boolean }) {
  const tpl = getTemplate(f.templateId);
  const [actErr, setActErr] = useState<string>();
  if (!tpl) return <div style={note}>找不到这件家具的模板（{f.templateId}）。</div>;
  const set = (patch: Record<string, unknown>) => commit([{ op: 'furniture.update', id: f.id, set: patch }]);
  const partSet = (partId: string, patch: { color?: string; material?: string } | null) =>
    commit([{ op: 'furniture.update', id: f.id, set: { appearance: { [partId]: patch } } }]);

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#3A342B' }}>{f.name}</div>
      <div style={note}>编号 {f.id} · 模板 {tpl.name} · 在「{design.rooms.find((r) => r.id === f.roomId)?.name ?? '？'}」</div>

      <div style={section}>
        <TextField label="名称" value={f.name} disabled={readOnly}
          commitText={(v) => commit([{ op: 'furniture.update', id: f.id, set: { name: v } }])} />
        <NumField label="长" value={f.l} disabled={readOnly} commitNum={(v) => set({ l: v })} suffix={`mm（${tpl.range.l[0]}–${tpl.range.l[1]}）`} />
        <NumField label="宽" value={f.w} disabled={readOnly} commitNum={(v) => set({ w: v })} suffix={`mm（${tpl.range.w[0]}–${tpl.range.w[1]}）`} />
        <NumField label="高" value={f.h} disabled={readOnly} commitNum={(v) => set({ h: v })} suffix={`mm（${tpl.range.h[0]}–${tpl.range.h[1]}）`} />
        <NumField label="朝向" value={f.rotation} disabled={readOnly} commitNum={(v) => set({ rotation: v })} suffix="°（顺时针）" />
        <NumField label="离地高度" value={f.elevation} disabled={readOnly} commitNum={(v) => set({ elevation: v })} suffix="mm" />
      </div>

      <div style={section}>
        <div style={sectionTitle}>部件外观（不设就跟随风格）</div>
        {tpl.parts.map((p) => {
          const own = f.appearance?.[p.id];
          const resolved = furniturePart(design, f, p.id);
          return (
            <div key={p.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: '#5A5245', marginBottom: 4 }}>{p.name}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 8 }}>
                <input type="color" value={resolved?.color ?? '#A89F8F'} disabled={readOnly}
                  onChange={(e) => partSet(p.id, { color: e.target.value.toUpperCase() })}
                  style={{ width: 34, height: 24, padding: 0, border: '1px solid #D8D2C4', borderRadius: 6, background: '#fff' }} />
                <select value={resolved?.material ?? p.materials[0]} disabled={readOnly}
                  onChange={(e) => partSet(p.id, { material: e.target.value })}
                  style={{ ...input(), width: 110, cursor: 'pointer' }}>
                  {p.materials.map((m) => <option key={m} value={m}>{MATERIAL_LABEL[m]}</option>)}
                </select>
                {own && !readOnly && <button onClick={() => partSet(p.id, null)} style={miniBtn}>恢复默认</button>}
              </div>
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <div style={section}>
          <button onClick={() => { const e = commit([{ op: 'furniture.remove', id: f.id }]); setActErr(e ?? undefined); }} style={dangerBtn}>
            删除家具
          </button>
          {actErr && <div style={{ ...errStyle, gridColumn: undefined }}>{actErr}</div>}
        </div>
      )}
    </div>
  );
}
