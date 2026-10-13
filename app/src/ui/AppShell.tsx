// 正式界面骨架（方案 8.4）：顶栏 + 左对话栏（M4 前为占位）+ 中间画布（试看/历史横幅）+ 右参数面板。
// 快捷键（方案 11.2）：Cmd/Ctrl+Z 撤销、加重做；Cmd/Ctrl+D 复制到不重叠位置；Delete 删除（房间先确认）；
// 方向键微调 10 mm，按住 Shift 100 mm，短时间内的连续微调合并为一步撤销（EDIT-03）。
import { useEffect, useRef, useState } from 'react';
import { actions, getStore, useApp } from './useApp';
import { can, displayDesign } from '../store/designStore';
import { exportProjectPackage, inspectProjectPackage, packageFileName } from '../persistence/projectPackage';
import { capturePreview } from './preview';
import { PlanCanvas } from '../plan/PlanCanvas';
import { Scene3D } from '../scene3d/Scene3D';
import { ParamPanel, roomRemovalSpec } from './ParamPanel';
import { FurniturePanel } from './FurniturePanel';
import { ConfirmDialog, type ConfirmSpec } from './ConfirmDialog';
import { HistoryDialog } from './HistoryDialog';
import { StyleDialog } from './StyleDialog';
import { ChatPanel } from './ChatPanel';
import { ModelSettingsDialog } from './ModelSettingsDialog';
import { getChat } from './chatClient';

const SAVE_TEXT = { saved: '已保存', unsaved: '未保存', saving: '保存中…', error: '保存失败' } as const;
const R = Math.round; // 指令里的毫米取整（schema 的 mm 是整数）

export function AppShell({ notice: bootNotice, persisted }: { notice?: string; persisted: boolean }) {
  const design = useApp(displayDesign);
  const session = useApp((s) => s.session);
  const overlay = session.overlay;
  const save = useApp((s) => s.save);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);

  const [wallKey, setWallKey] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlRef = useRef<string | undefined>(undefined); // 导入确认框里预览图的对象地址，关框即释放
  const importingRef = useRef(false); // 读包期间不再受理第二个文件，避免确认框被旧结果覆盖

  // 通知条：操作结果在这里短暂显示，4 秒后自动消失
  const [notice, setNoticeState] = useState<{ text: string; level: 'info' | 'error' } | null>(
    () => (bootNotice ? { text: bootNotice, level: 'info' } : null),
  );
  const noticeTimer = useRef<number | undefined>(undefined);
  const setNotice = (text: string, level: 'info' | 'error' = 'info') => {
    setNoticeState({ text, level });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNoticeState(null), 4000);
  };
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  // 侧栏收起：首次按模式定（PAGE-03），手动切换后记住；窗口太窄时自动收起
  const [chatOpenSaved, setChatOpenSaved] = useState<boolean | null>(() => {
    const v = localStorage.getItem('rd:chat-open');
    return v === null ? null : v === '1';
  });
  const [panelOpen, setPanelOpen] = useState(true);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1099px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1099px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const chatOpen = !narrow && (chatOpenSaved ?? session.mode === 'edit');
  const showPanel = !narrow && panelOpen;
  const toggleChat = () => {
    const next = !chatOpen;
    setChatOpenSaved(next);
    localStorage.setItem('rd:chat-open', next ? '1' : '0');
  };

  // ---------- 快捷键 ----------

  /** 复制：往四周找第一个引擎检查通过（不重叠、不越界）的位置 */
  const duplicateSelection = () => {
    const s = getStore().getState();
    const sel = s.session.selection;
    if (!sel) return;
    if (sel.kind === 'wall') { setNotice('墙由房间位置决定，不能复制', 'info'); return; }
    const d = s.design;

    const tryPlace = (make: (dx: number, dy: number) => unknown[], offsets: [number, number][]): boolean => {
      for (const [dx, dy] of offsets) {
        const ops = make(dx, dy);
        if (!actions().check(ops).ok) continue;
        const r = actions().commit(ops);
        if (!r.ok) { setNotice(r.message, 'error'); return true; }
        const id = r.result?.created?.['new:copy'];
        if (id) actions().select({ kind: sel.kind === 'opening' ? 'opening' : sel.kind, id });
        const warn = (r.result?.warnings ?? []).map((w) => w.message).join('；');
        setNotice(warn ? `${r.message}；${warn}` : r.message);
        return true;
      }
      return false;
    };

    if (sel.kind === 'room') {
      const r = d.rooms.find((x) => x.id === sel.id);
      if (!r) return;
      const step = (a: number) => a + 300;
      const offsets: [number, number][] = [];
      for (const k of [1, 2, 3]) {
        const gx = k * step(r.length), gy = k * step(r.width);
        offsets.push([gx, 0], [0, gy], [-gx, 0], [0, -gy], [gx, gy], [-gx, gy], [gx, -gy], [-gx, -gy]);
      }
      const done = tryPlace(
        (dx, dy) => [{
          op: 'room.add', tempId: 'new:copy',
          room: {
            name: `${r.name} 副本`, usage: r.usage, x: r.x + dx, y: r.y + dy,
            length: r.length, width: r.width, planColor: r.planColor,
            ...(r.floor ? { floor: r.floor } : {}), ...(r.wallColors ? { wallColors: r.wallColors } : {}),
          },
        }],
        offsets,
      );
      if (!done) setNotice('周围放不下房间副本，先把别的东西挪开一点', 'error');
      return;
    }

    if (sel.kind === 'furniture') {
      const f = d.furniture.find((x) => x.id === sel.id);
      const room = f ? d.rooms.find((r) => r.id === f.roomId) : undefined;
      if (!f || !room) return;
      // 在原房间里按“离原位置由近到远”扫描候选中心（300 mm 步进），取第一个引擎检查通过的位置
      const rad = (f.rotation * Math.PI) / 180;
      const halfX = (Math.abs(Math.cos(rad)) * f.l + Math.abs(Math.sin(rad)) * f.w) / 2;
      const halfY = (Math.abs(Math.sin(rad)) * f.l + Math.abs(Math.cos(rad)) * f.w) / 2;
      const step = 300;
      const xs: number[] = [], ys: number[] = [];
      for (let x = Math.ceil((room.x + halfX) / 100) * 100; x <= room.x + room.length - halfX; x += step) xs.push(x);
      for (let y = Math.ceil((room.y + halfY) / 100) * 100; y <= room.y + room.width - halfY; y += step) ys.push(y);
      const candidates: [number, number][] = [];
      for (const x of xs) for (const y of ys) candidates.push([x, y]);
      candidates.sort((a, b) => ((a[0] - f.cx) ** 2 + (a[1] - f.cy) ** 2) - ((b[0] - f.cx) ** 2 + (b[1] - f.cy) ** 2));
      const done = tryPlace(
        (x, y) => [{
          op: 'furniture.add', tempId: 'new:copy',
          furniture: {
            templateId: f.templateId, roomId: f.roomId, cx: R(x), cy: R(y),
            rotation: f.rotation, l: f.l, w: f.w, h: f.h, elevation: f.elevation,
            name: `${f.name} 副本`, ...(f.appearance ? { appearance: f.appearance } : {}),
          },
        }],
        candidates,
      );
      if (!done) setNotice(`房间里放不下「${f.name}」的副本`, 'error');
      return;
    }

    // 门窗：沿墙前后找放得下的位置
    const o = d.openings.find((x) => x.id === sel.id);
    if (!o) return;
    const g = o.width + 100;
    const offsets: [number, number][] = [];
    for (const k of [1, 2, 3]) offsets.push([k * g, 0], [-k * g, 0]);
    const done = tryPlace(
      (dx) => [{
        op: 'opening.add', tempId: 'new:copy',
        opening: {
          kind: o.kind, hostRoomId: o.hostRoomId, side: o.side, offset: o.offset + dx,
          width: o.width, height: o.height, sill: o.sill,
          ...(o.use ? { use: o.use } : {}), ...(o.openMode ? { openMode: o.openMode } : {}),
          ...(o.hinge ? { hinge: o.hinge } : {}), ...(o.swingInto ? { swingInto: o.swingInto } : {}),
          ...(o.slideTo ? { slideTo: o.slideTo } : {}), ...(o.windowType ? { windowType: o.windowType } : {}),
          ...(o.colors ? { colors: o.colors } : {}),
        },
      }],
      offsets,
    );
    if (!done) setNotice('这面墙上放不下第二个一样的门窗', 'error');
  };

  /** 删除选中对象；房间先弹确认框列明影响（EDIT-05） */
  const removeSelection = () => {
    const s = getStore().getState();
    const sel = s.session.selection;
    if (!sel) return;
    if (sel.kind === 'room') {
      const room = s.design.rooms.find((r) => r.id === sel.id);
      if (!room) return;
      setConfirm(roomRemovalSpec(s.design, sel.id, (m) => setNotice(m, 'error')));
      return;
    }
    if (sel.kind === 'wall') { setNotice('墙由房间决定：删房间、或在墙面板勾选“开放”', 'info'); return; }
    const opName = sel.kind === 'furniture' ? 'furniture.remove' : 'opening.remove';
    const r = actions().commit([{ op: opName, id: sel.id }]);
    if (!r.ok) setNotice(r.message, 'error');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        if (confirm) return; // 确认框自己处理 Esc
        if (armed) setArmed(null);
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const s = getStore().getState();
        const allowed = can(s, 'undo');
        if (!allowed.ok) { setNotice(allowed.reason!, 'error'); return; }
        const ok = e.shiftKey ? actions().redo() : actions().undo();
        if (ok) setNotice(e.shiftKey ? '已重做' : '已撤销');
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelection(); return; }

      if (e.key.startsWith('Arrow')) {
        const s = getStore().getState();
        const sel = s.session.selection;
        if (!sel || sel.kind === 'wall') return;
        const step = e.shiftKey ? 100 : 10;
        const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
        const sign = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
        e.preventDefault();
        const add =
          sel.kind === 'room' ? (horizontal ? { x: sign * step } : { y: sign * step })
          : sel.kind === 'furniture' ? (horizontal ? { cx: sign * step } : { cy: sign * step })
          : { offset: sign * step };
        const r = actions().commit(
          [{ op: `${sel.kind}.update`, id: sel.id, add }],
          { mergeKey: `nudge:${sel.kind}:${sel.id}` },
        );
        if (!r.ok) setNotice(r.message, 'error');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, armed]);

  // ---------- 顶栏分档按钮 ----------

  const seg = (value: string, options: { v: string; t: string; disabled?: boolean; title?: string }[], onPick: (v: string) => void) => (
    <div style={segWrap}>
      {options.map((o) => (
        <button key={o.v} disabled={o.disabled} title={o.title}
          onClick={() => onPick(o.v)} style={segBtn(value === o.v, o.disabled)}>{o.t}</button>
      ))}
    </div>
  );

  const historyViewing = overlay.type === 'history';
  // 应用/放弃试看：结果由程序显示（方案 17 节第 1 条），并带入下一轮 AI 请求
  const onApplyTrial = async () => {
    const r = await actions().applyTrial();
    setNotice(r.message);
    getChat().noteTrialOutcome(r.message);
  };
  const onDiscardTrial = () => {
    const r = actions().discardTrial();
    setNotice(r.message);
    getChat().noteTrialOutcome(r.message);
  };

  // 试看过期：提示一次（AI-07、TRY-06）
  const trialStale = overlay.type === 'trial' && overlay.stale ? overlay.staleReason ?? '' : null;
  const staleNotifiedRef = useRef(false);
  useEffect(() => {
    if (trialStale) {
      if (!staleNotifiedRef.current) {
        staleNotifiedRef.current = true;
        getChat().noteTrialOutcome(`试看已过期：${trialStale}。可以点“重新生成”让 AI 重新给方案`);
      }
    } else {
      staleNotifiedRef.current = false;
    }
  }, [trialStale]);
  const onRestore = async () => setNotice((await actions().restoreHistory()).message);

  // ---------- 项目包导入导出（方案 9.4、9.5 节） ----------

  /** 导出当前设计为项目包并触发下载；自动保存失败时也用它做“导出备份”（SAVE-02） */
  const onExportProject = async () => {
    const s = getStore().getState();
    const allowed = can(s, 'importExport');
    if (!allowed.ok) { setNotice(allowed.reason!, 'error'); return; }
    setNotice('正在导出项目包…');
    try {
      const preview = await capturePreview(640);
      const blob = await exportProjectPackage(s.design, preview);
      const name = packageFileName(s.design.meta.name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 8000);
      setNotice(`已导出「${name}」，在浏览器的下载文件夹里`);
    } catch (e) {
      setNotice(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /** 导入：读包检查（9.5 第 1～4 步），通过后显示摘要与预览图，确认才替换（第 5～6 步） */
  const onImportFile = async (file: File) => {
    if (importingRef.current) { setNotice('正在读取上一个文件，请稍候', 'error'); return; }
    importingRef.current = true;
    try {
      let c: Awaited<ReturnType<typeof inspectProjectPackage>>;
      try { c = await inspectProjectPackage(file); }
      catch (e) {
        setConfirm({
          title: '无法导入项目包',
          lines: [`读取文件出错：${e instanceof Error ? e.message : String(e)}`],
          confirmText: '知道了', hideCancel: true,
          onConfirm: () => { /* 只作说明 */ },
        });
        return;
      }
      if (!c.ok) {
        setConfirm({
          title: '无法导入项目包',
          lines: [c.reason, ...(c.details ?? []).slice(0, 5)],
          confirmText: '知道了', hideCancel: true,
          onConfirm: () => { /* 只作说明 */ },
        });
        return;
      }
      const at = Date.parse(c.summary.exportedAt ?? '');
      const exportedAt = Number.isFinite(at) ? new Date(at).toLocaleString() : '（文件里没写）';
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); // 上一份确认框还开着时换文件，先释放旧地址
      previewUrlRef.current = c.preview ? URL.createObjectURL(c.preview) : undefined;
      setConfirm({
        title: '导入项目包',
        lines: [
          `名称：${c.summary.name}`,
          `内容：${c.summary.rooms} 个房间、${c.summary.openings} 处门窗、${c.summary.furniture} 件家具`,
          `导出于：${exportedAt}`,
          '导入前会先把当前设计自动保存为历史版本；替换后可以撤销。',
        ],
        image: previewUrlRef.current,
        confirmText: '替换当前设计',
        onConfirm: () => {
          void actions().replaceDesign(c.design, '导入替换前')
            .then((r) => setNotice(r.message, r.ok ? 'info' : 'error'));
        },
      });
    } finally {
      importingRef.current = false;
    }
  };

  /** EDIT-05、VER-02：清空设计先列明影响并确认；确认后先自动存「清空前」版本再清空。风格、展示设置、默认墙厚和设计名称保留（引擎 design.clear 的语义） */
  const onClearDesign = () => {
    const s = getStore().getState();
    const allowed = can(s, 'edit');
    if (!allowed.ok) { setNotice(allowed.reason!, 'error'); return; }
    if (s.session.mode !== 'edit') { setNotice('当前是预览模式，请先切换到编辑模式', 'error'); return; }
    setConfirm({
      title: '清空设计',
      lines: [
        `删除全部 ${s.design.rooms.length} 个房间、${s.design.openings.length} 处门窗和 ${s.design.furniture.length} 件家具摆放，重新开始。`,
        '风格、展示设置、默认墙厚和设计名称会保留。',
        '清空前会先把当前设计自动保存为历史版本；清空后可以撤销。',
      ],
      confirmText: '清空',
      onConfirm: () => {
        void actions().commitWithBackup([{ op: 'design.clear' }], '清空前')
          .then((r) => setNotice(r.message, r.ok ? 'info' : 'error'));
      },
    });
  };

  // 历史版本/风格设置：有未处理的试看时先处理试看（方案 8.2 表）
  const openHistoryDialog = () => {
    if (getStore().getState().session.overlay.type === 'trial') { setNotice('请先应用或放弃当前试看，再打开历史版本', 'error'); return; }
    setHistoryOpen(true);
  };
  const openStyleDialog = () => {
    const o = getStore().getState().session.overlay;
    if (o.type === 'history') { setNotice('正在查看历史版本，请先退出查看，再调整风格', 'error'); return; }
    if (o.type === 'trial' && o.source !== 'style') { setNotice('当前是 AI 试看，请先应用或放弃，或在对话里继续调整', 'error'); return; }
    setStyleOpen(true); // 风格试看中打开＝继续调整当前试看（TRY-03）
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#F4F1E9', fontFamily: 'system-ui, sans-serif', color: '#3A342B' }}>
      {/* 顶栏（方案 8.4） */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', height: 46, background: '#EFEAE0', borderBottom: '1px solid #DDD6C6', flexShrink: 0 }}>
        <strong style={{ fontSize: 13.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={design.meta.name}>
          {design.meta.name}
        </strong>
        {seg(session.page, [
          { v: 'plan', t: '平面图' },
          { v: '3d', t: '3D' },
        ], (v) => actions().setPage(v as 'plan'))}
        {seg(session.mode, [{ v: 'preview', t: '预览' }, { v: 'edit', t: '编辑' }], (v) => actions().setMode(v as 'preview' | 'edit'))}
        {seg(session.dimension, [{ v: 'room', t: '房间' }, { v: 'furniture', t: '家具' }], (v) => { setArmed(null); actions().setDimension(v as 'room'); })}
        <div style={segWrap}>
          <button disabled={!canUndo || historyViewing} title={historyViewing ? '查看历史版本时不能撤销' : 'Cmd/Ctrl+Z'}
            onClick={() => actions().undo()} style={segBtn(false)}>↶</button>
          <button disabled={!canRedo || historyViewing} title="Shift+Cmd/Ctrl+Z"
            onClick={() => actions().redo()} style={segBtn(false)}>↷</button>
        </div>
        <span data-testid="save" style={{
          fontSize: 12, padding: '3px 10px', borderRadius: 10,
          background: save.status === 'error' ? '#F6D5D5' : save.status === 'saved' ? '#DCECDC' : save.status === 'saving' ? '#E6E1F0' : '#F3EAD6',
          color: save.status === 'error' ? '#7A2E24' : '#5A5245', whiteSpace: 'nowrap',
        }} title={save.error ?? (save.savedAt ? `保存于 ${save.savedAt}` : undefined)}>
          {SAVE_TEXT[save.status]}{save.error ? `：${save.error}` : ''}
        </span>
        {save.status === 'error' && (
          <button onClick={() => { void onExportProject(); }} style={backupBtn}
            title="把当前设计导出成项目包文件留底，避免丢失（SAVE-02）">导出备份</button>
        )}
        <span style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <button onClick={() => setMenuOpen((v) => !v)} style={segBtn(false)} title="导入导出、历史版本、风格、模型服务">⋯</button>
          {menuOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setMenuOpen(false)} />
              <div style={{
                position: 'absolute', right: 0, top: 34, zIndex: 31, minWidth: 220,
                background: '#fff', border: '1px solid #D8D2C4', borderRadius: 10,
                boxShadow: '0 8px 24px rgba(40,35,25,.18)', padding: '6px 0', fontSize: 13,
              }}>
                {/* 方案 8.2 表：试看/历史查看中导入导出置灰并说明原因（风格设置同理；风格试看中放行＝继续调整，TRY-03） */}
                {(() => {
                  const s = getStore().getState();
                  const o = s.session.overlay;
                  const oe = o.type;
                  const ioBlocked = oe !== 'none' ? can(s, 'importExport').reason : undefined;
                  const histBlocked = oe === 'trial' ? can(s, 'openHistory').reason : undefined;
                  const styleBlocked = oe === 'history'
                    ? can(s, 'startTrial').reason
                    : oe === 'trial' && o.source !== 'style' ? '当前是 AI 试看，请先应用或放弃' : undefined;
                  const clearBlocked = oe === 'history'
                    ? can(s, 'edit').reason
                    : s.session.mode !== 'edit' ? '当前是预览模式，请先切换到编辑模式' : undefined;
                  const items: { t: string; run: () => void; reason?: string }[] = [
                    { t: '导入项目包', run: () => importInputRef.current?.click(), reason: ioBlocked },
                    { t: '导出项目包', run: () => { void onExportProject(); }, reason: ioBlocked },
                    { t: '历史版本', run: openHistoryDialog, reason: histBlocked },
                    { t: '风格设置', run: openStyleDialog, reason: styleBlocked },
                    { t: '清空设计', run: onClearDesign, reason: clearBlocked },
                  ];
                  return items.map((m) => (
                    <button key={m.t} disabled={!!m.reason} title={m.reason}
                      onClick={() => { setMenuOpen(false); m.run(); }}
                      style={{
                        width: '100%', textAlign: 'left', padding: '7px 14px', border: 'none',
                        background: 'transparent', fontSize: 13, cursor: m.reason ? 'default' : 'pointer',
                        color: m.reason ? '#B0A99B' : '#3A342B',
                        display: 'flex', justifyContent: 'space-between', gap: 12,
                      }}
                      onMouseEnter={(e) => { if (!m.reason) e.currentTarget.style.background = '#F1ECE0'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      <span>{m.t}</span>
                      {m.reason && <span style={{ fontSize: 11 }}>暂不可用</span>}
                    </button>
                  ));
                })()}
                <button
                  onClick={() => { setMenuOpen(false); setModelSettingsOpen(true); }}
                  style={{ width: '100%', textAlign: 'left', padding: '7px 14px', border: 'none', background: 'transparent', fontSize: 13, color: '#3A342B', cursor: 'pointer' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#F1ECE0'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >模型服务设置</button>
                <div style={{ borderTop: '1px solid #EDE8DC', margin: '6px 0', padding: '7px 14px', fontSize: 11.5, color: '#8A8172', lineHeight: 1.6 }}>
                  持久存储：{persisted ? '已授予，数据可长期保存' : '未授予，自动保存可能随浏览器清理丢失'}
                  <br />尺寸和布局仅用于装修展示，不能作为承重判断、消防合规、结构安全或施工依据。
                </div>
              </div>
            </>
          )}
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 左：对话栏（M4） */}
        {chatOpen ? (
          <ChatPanel onOpenSettings={() => { setMenuOpen(false); setModelSettingsOpen(true); }} />
        ) : (
          <button onClick={toggleChat} style={sideTab} title="展开对话栏"><span style={verticalText}>对话</span></button>
        )}

        {/* 中：横幅 + 通知 + 画布 */}
        <main style={{ flex: 1, minWidth: 600, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
          {overlay.type === 'trial' && (
            <div style={{ ...bannerBase, background: '#F6E7DC', borderBottomColor: '#E4C4BE' }} data-testid="trial-banner">
              <strong style={{ color: '#8A3B2E' }}>试看中，尚未应用</strong>
              {overlay.summary && <span style={{ fontSize: 12.5 }}>：{overlay.summary}</span>}
              <span style={{ fontSize: 12, color: '#8A8172' }}>（{overlay.changes.length} 项修改，虚线为改动处）</span>
              {overlay.stale && (
                <span style={{ fontSize: 12, color: '#C0392B' }} data-testid="trial-stale">⚠ 已过期：{overlay.staleReason}</span>
              )}
              <span style={{ flex: 1 }} />
              {overlay.stale && (
                <button onClick={() => { void getChat().resendLast(); }} style={bannerBtn(false)} title="把刚才的要求重新发给 AI">重新生成</button>
              )}
              <button disabled={overlay.stale} title={overlay.stale ? '试看已过期，请放弃后重新生成' : undefined}
                onClick={() => { void onApplyTrial(); }} style={bannerBtn(true)}>应用</button>
              <button onClick={onDiscardTrial} style={bannerBtn(false)}>放弃</button>
            </div>
          )}
          {overlay.type === 'history' && (
            <div style={{ ...bannerBase, background: '#EAE3D0', borderBottomColor: '#D8D2C4' }} data-testid="history-banner">
              <strong>正在查看历史版本「{overlay.versionName}」，尚未恢复</strong>
              <span style={{ flex: 1 }} />
              <button onClick={() => { void onRestore(); }} style={bannerBtn(true)}>恢复此版本</button>
              <button onClick={() => actions().exitHistory()} style={bannerBtn(false)}>退出查看</button>
            </div>
          )}
          {notice && (
            <div style={{
              padding: '6px 14px', fontSize: 12.5, borderBottom: '1px solid #E7E1D2',
              background: notice.level === 'error' ? '#FBEDEB' : '#F3EFE4',
              color: notice.level === 'error' ? '#7A2E24' : '#5A5245',
            }} data-testid="notice">{notice.text}</div>
          )}

          {session.page === 'plan'
            ? <PlanCanvas armedTemplateId={armed} onArmCancel={() => setArmed(null)} wallKey={wallKey} onWallPick={setWallKey} />
            : <Scene3D onWallPick={setWallKey} />}
        </main>

        {/* 右：参数面板（家具维度时上方多一个模板列表） */}
        {showPanel ? (
          <aside style={{ width: 300, flexShrink: 0, borderLeft: '1px solid #DDD6C6', background: '#F8F5EE', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid #E7E1D2' }}>
              <strong style={{ fontSize: 12.5, flex: 1 }}>参数</strong>
              <button onClick={() => setPanelOpen(false)} style={flatBtn} title="收起参数面板">›</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
              {session.dimension === 'furniture' && (
                <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid #E7E1D2' }}>
                  <FurniturePanel armed={armed} onArm={setArmed} />
                </div>
              )}
              <ParamPanel wallKey={wallKey} onConfirm={setConfirm} />
            </div>
          </aside>
        ) : (
          <button onClick={() => setPanelOpen(true)} style={{ ...sideTab, borderLeft: '1px solid #DDD6C6', borderRight: 'none' }} title="展开参数面板">
            <span style={verticalText}>参数</span>
          </button>
        )}
      </div>

      {/* 导入项目包的隐藏文件选择框；清掉 value 让同名文件可以再次触发 */}
      <input ref={importInputRef} type="file" accept=".zip" style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onImportFile(f);
        }} />
      <ConfirmDialog spec={confirm} onClose={() => {
        if (previewUrlRef.current) { URL.revokeObjectURL(previewUrlRef.current); previewUrlRef.current = undefined; }
        setConfirm(null);
      }} />
      {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} onNotice={setNotice} onConfirm={setConfirm} />}
      {styleOpen && <StyleDialog onClose={() => setStyleOpen(false)} onNotice={setNotice} />}
      {modelSettingsOpen && <ModelSettingsDialog onClose={() => setModelSettingsOpen(false)} />}
    </div>
  );
}

// ---------- 样式 ----------

const segWrap: React.CSSProperties = {
  display: 'flex', background: '#E4DECE', borderRadius: 9, padding: 2, gap: 2,
};
const segBtn = (active: boolean, disabled?: boolean): React.CSSProperties => ({
  border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 12.5,
  background: active ? '#fff' : 'transparent', color: disabled ? '#B0A99B' : active ? '#3A342B' : '#6B6459',
  cursor: disabled ? 'default' : 'pointer', boxShadow: active ? '0 1px 2px rgba(40,35,25,.15)' : undefined,
});
const flatBtn: React.CSSProperties = {
  border: '1px solid #D8D2C4', background: '#fff', borderRadius: 6, width: 22, height: 22,
  cursor: 'pointer', color: '#5A5245', fontSize: 13, lineHeight: 1, padding: 0,
};
const backupBtn: React.CSSProperties = {
  border: '1px solid #C25B4E', background: '#fff', color: '#C25B4E', borderRadius: 8,
  padding: '3px 10px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
};
const bannerBase: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', fontSize: 13,
  borderBottom: '1px solid #E4C4BE', flexShrink: 0,
};
const bannerBtn = (primary: boolean): React.CSSProperties => ({
  border: `1px solid ${primary ? '#C25B4E' : '#D8D2C4'}`, background: primary ? '#C25B4E' : '#fff',
  color: primary ? '#fff' : '#5A5245', borderRadius: 8, padding: '4px 14px', fontSize: 12.5, cursor: 'pointer',
});
const sideTab: React.CSSProperties = {
  width: 24, flexShrink: 0, border: 'none', borderRight: '1px solid #DDD6C6', background: '#EFEAE0',
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
};
const verticalText: React.CSSProperties = {
  writingMode: 'vertical-rl', fontSize: 12, color: '#8A8172', letterSpacing: 2,
};
