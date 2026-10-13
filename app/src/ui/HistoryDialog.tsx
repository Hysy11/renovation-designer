// 历史版本界面（方案 9.3 节、需求 VER-01～08）：
// 顶部“保存为版本”可命名（VER-01）；列表新→旧，带缩略图、手动/自动/备份与原因（VER-03）；
// 可改名、删除（需确认）、查看（进入历史查看横幅，先看再恢复，VER-04）。
// 查看历史版本时仍可打开本窗切换到另一个版本，但不能保存版本（方案 8.2 表）。
import { useEffect, useRef, useState } from 'react';
import { actions, getStore } from './useApp';
import { can } from '../store/designStore';
import { appDB } from './dbAccess';
import { deleteVersion, getThumb, getVersion, listVersions, renameVersion, saveVersion, saveThumb } from '../persistence/versions';
import type { VersionRecord } from '../persistence/db';
import { migrateAndCheck } from '../engine/load';
import { capturePreview } from './preview';
import type { ConfirmSpec } from './ConfirmDialog';

const KIND_LABEL: Record<VersionRecord['kind'], string> = { manual: '手动', auto: '自动', backup: '备份' };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const btn = (primary = false, danger = false): React.CSSProperties => ({
  border: `1px solid ${primary ? '#C25B4E' : danger ? '#C0392B' : '#D8D2C4'}`,
  background: primary || danger ? (primary ? '#C25B4E' : '#C0392B') : '#fff',
  color: primary || danger ? '#fff' : '#5A5245', borderRadius: 8, padding: '4px 12px', fontSize: 12, cursor: 'pointer',
});

interface Props {
  onClose: () => void;
  onNotice: (text: string, level?: 'info' | 'error') => void;
  onConfirm: (spec: ConfirmSpec) => void;
}

export function HistoryDialog({ onClose, onNotice, onConfirm }: Props) {
  const [list, setList] = useState<VersionRecord[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRef = useRef<Record<string, string>>({});
  const [saveName, setSaveName] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const viewingHistory = getStore().getState().session.overlay.type === 'history';
  const aliveRef = useRef(true);       // 卸载后不再 setState，也不再向 thumbsRef 写新地址
  const reloadSeqRef = useRef(0);      // 并发 reload 时只有最新一次的结果生效

  const reload = async () => {
    const seq = ++reloadSeqRef.current;
    try {
      const db = appDB();
      const vs = await listVersions(db);
      const next: Record<string, string> = {};
      for (const v of vs) {
        const b = await getThumb(db, v.id);
        if (b) next[v.id] = URL.createObjectURL(b);
      }
      // 期间又发起了一次 reload 或窗口已关闭：这次的结果作废，立即释放刚建的地址
      if (!aliveRef.current || seq !== reloadSeqRef.current) {
        for (const u of Object.values(next)) URL.revokeObjectURL(u);
        return;
      }
      setList(vs);
      for (const u of Object.values(thumbsRef.current)) if (u) URL.revokeObjectURL(u); // 换新图前释放旧地址
      thumbsRef.current = next;
      setThumbs(next);
    } catch {
      if (aliveRef.current && seq === reloadSeqRef.current) {
        setList((prev) => prev ?? []);
        onNotice('历史版本读不出来（本地存储出错）', 'error');
      }
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !renameId) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('keydown', onKey);
      for (const u of Object.values(thumbsRef.current)) if (u) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameId]);

  /** VER-01：保存为版本；缩略图截当前画面（3D 可用截 3D，宽 320，否则平面图），失败不影响版本本身 */
  const onSaveVersion = async () => {
    const s = getStore().getState();
    const allowed = can(s, 'saveVersion');
    if (!allowed.ok) { onNotice(allowed.reason!, 'error'); return; }
    const db = appDB();
    let r;
    try { r = await saveVersion(db, { design: s.design, kind: 'manual', name: saveName }); }
    catch { onNotice('版本保存失败：本地存储出错', 'error'); return; }
    if (!r.ok) { onNotice(r.message, 'error'); return; }
    setSaveName('');
    onNotice(r.message);
    // 缩略图异步落库；期间版本可能已被删除，先确认还在再写，避免留下无主记录
    void capturePreview(320)
      .then(async (b) => { if (b && r.record && (await getVersion(db, r.record.id))) await saveThumb(db, r.record.id, b); })
      .catch(() => undefined);
    await reload();
  };

  /** VER-04：先查看再恢复；查看进历史查看叠加层，恢复由横幅上的按钮触发 */
  const onView = (v: VersionRecord) => {
    const r = migrateAndCheck(v.design);
    if (!r.ok) { onNotice(`这个版本读不出来：${r.reason}`, 'error'); return; }
    const res = actions().openHistory(v.id, v.name, r.design);
    if (!res.ok) { onNotice(res.message, 'error'); return; }
    onClose();
  };

  const onRename = async (v: VersionRecord) => {
    if (!renameDraft.trim()) { onNotice('版本名称不能为空', 'error'); return; }
    let ok: boolean;
    try { ok = await renameVersion(appDB(), v.id, renameDraft); }
    catch { ok = false; }
    setRenameId(null);
    onNotice(ok ? `已改名为「${renameDraft.trim()}」` : '改名失败：本地存储出错或版本已被删除', ok ? 'info' : 'error');
    await reload();
  };

  const onDelete = (v: VersionRecord) => {
    onConfirm({
      title: '删除历史版本',
      lines: [`「${v.name}」（${fmtTime(v.createdAt)}，${KIND_LABEL[v.kind]}）`, '删除后无法恢复。'],
      confirmText: '删除',
      onConfirm: () => {
        void (async () => {
          try {
            await deleteVersion(appDB(), v.id);
            onNotice(`已删除版本「${v.name}」`);
          } catch {
            onNotice('删除失败：本地存储出错', 'error');
          }
          await reload();
        })();
      },
    });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(40,35,25,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="history-dialog">
      <div style={{ width: 580, maxWidth: '94vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: '#FBF8F1', borderRadius: 14, border: '1px solid #D8D2C4', boxShadow: '0 12px 40px rgba(40,35,25,.25)', padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <strong style={{ fontSize: 14, flex: 1 }}>历史版本</strong>
          <button onClick={onClose} style={btn()} title="关闭">✕</button>
        </div>

        {/* 保存为版本（VER-01）。查看历史版本时不能保存（方案 8.2 表） */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', background: '#F3EFE4', borderRadius: 10, marginBottom: 10 }}>
          <input
            value={saveName} onChange={(e) => setSaveName(e.target.value)}
            placeholder="版本名称（不填按时间命名，如：客厅方案A）"
            disabled={viewingHistory}
            onKeyDown={(e) => { if (e.key === 'Enter') void onSaveVersion(); }}
            style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid #D8D2C4', background: '#fff', fontSize: 12.5, color: '#3A342B' }} />
          <button disabled={viewingHistory} title={viewingHistory ? '查看历史版本时不能保存版本，请先退出查看' : undefined}
            onClick={() => { void onSaveVersion(); }} style={btn(true)}>保存为版本</button>
        </div>

        {/* 列表（VER-03）：缩略图 + 名称 + 时间 + 手动/自动/备份；操作：查看 / 改名 / 删除 */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 120 }}>
          {list === null ? (
            <div style={{ padding: 20, fontSize: 12.5, color: '#8A8172', textAlign: 'center' }}>正在读取…</div>
          ) : list.length === 0 ? (
            <div style={{ padding: '24px 12px', fontSize: 12.5, color: '#8A8172', lineHeight: 2, textAlign: 'center' }}>
              还没有历史版本。<br />
              风险操作（应用 AI 修改、删除房间、导入、恢复）前会自动存版本；自动版只保留最近 20 个。
            </div>
          ) : list.map((v) => (
            <div key={v.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 6px', borderBottom: '1px solid #EDE8DC' }}>
              {thumbs[v.id]
                ? <img src={thumbs[v.id]} alt="" style={{ width: 96, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid #E7E1D2', flexShrink: 0 }} />
                : <div style={{ width: 96, height: 56, borderRadius: 6, border: '1px dashed #D8D2C4', background: '#EFEAE0', color: '#B0A99B', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>无缩略图</div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                {renameId === v.id ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void onRename(v);
                        if (e.key === 'Escape') { e.stopPropagation(); setRenameId(null); } // 只退出改名，不关窗口
                      }}
                      style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid #D8D2C4', fontSize: 12.5 }} />
                    <button onClick={() => { void onRename(v); }} style={btn(true)}>确定</button>
                    <button onClick={() => setRenameId(null)} style={btn()}>取消</button>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 13, color: '#3A342B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</div>
                    <div style={{ fontSize: 11.5, color: '#8A8172' }}>
                      {fmtTime(v.createdAt)} · {KIND_LABEL[v.kind]}{v.reason ? ` · ${v.reason}` : ''}
                    </div>
                  </>
                )}
              </div>
              {renameId !== v.id && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => { setRenameId(v.id); setRenameDraft(v.name); }} style={btn()} title="改名">改名</button>
                  <button onClick={() => onDelete(v)} style={btn(false, true)} title="删除（需确认）">删除</button>
                  <button onClick={() => onView(v)} style={btn(true)} title="查看这个版本，恢复请用横幅上的按钮">查看</button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11.5, color: '#8A8172', marginTop: 8, lineHeight: 1.6 }}>
          版本只保存在本机浏览器，不随项目包导出（VER-08）。查看只切换显示，恢复前会先自动保存当前设计。
        </div>
      </div>
    </div>
  );
}
