// 确认框（EDIT-05）：删除房间、清空设计等有连带影响的操作先列明后果，取消则什么都不做。
import { useEffect, useRef } from 'react';

export interface ConfirmSpec {
  title: string;
  lines: (string | null | undefined)[];
  confirmText?: string;
  /** 预览图的对象地址（导入项目包时显示 preview.png）；由调用方负责创建和释放 */
  image?: string;
  /** 只留一个按钮（错误说明等场景），Esc 和点遮罩仍可关闭 */
  hideCancel?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec | null; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!spec) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spec, onClose]);
  if (!spec) return null;
  const lines = spec.lines.filter((l): l is string => !!l);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(60,55,45,.35)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div role="dialog" aria-modal onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, padding: '20px 22px', minWidth: 320, maxWidth: 440,
          boxShadow: '0 12px 40px rgba(40,35,25,.28)', fontFamily: 'system-ui, sans-serif',
        }}>
        <div style={{ fontSize: 15.5, fontWeight: 600, color: '#3A342B', marginBottom: 10 }}>{spec.title}</div>
        {lines.map((l, i) => (
          <div key={i} style={{ fontSize: 13, color: '#5A5245', lineHeight: 1.7 }}>· {l}</div>
        ))}
        {spec.image && (
          <img src={spec.image} alt="项目包预览"
            onError={(e) => { e.currentTarget.style.display = 'none'; }} // 包里的预览图损坏时不显示裂图，摘要文字仍可确认
            style={{ display: 'block', maxWidth: '100%', maxHeight: 220, margin: '12px auto 0', borderRadius: 8, border: '1px solid #E7E1D2' }} />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          {!spec.hideCancel && (
            <button ref={cancelRef} onClick={onClose}
              style={btn('#fff', '#8A8172')}>取消</button>
          )}
          <button ref={spec.hideCancel ? cancelRef : undefined} onClick={() => { spec.onConfirm(); onClose(); }}
            style={btn('#C25B4E', '#fff')}>{spec.confirmText ?? '确认删除'}</button>
        </div>
      </div>
    </div>
  );
}

const btn = (bg: string, fg: string): React.CSSProperties => ({
  padding: '6px 16px', borderRadius: 8, border: '1px solid #D8D2C4', background: bg, color: fg,
  fontSize: 13, cursor: 'pointer',
});
