// 对话栏（方案 8.4、10.4，需求 7.1）：消息流、输入框、发送/停止、图片附件（最多 3 张/轮）、
// 试看结果的程序显示（应用/放弃后由 AppShell 写入 noteTrialOutcome）。
// ChatController 的消息既给 UI 显示，也作为下一轮请求的历史（status 除外）。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getChat, getSettings, onSettingsChange } from './chatClient';
import { compressImage, MAX_IMAGES_PER_TURN } from '../ai/image';
import type { ChatImage } from '../ai/types';
import { VENDORS } from '../ai/vendors';

const flatBtn: React.CSSProperties = {
  border: '1px solid #D8D2C4', background: '#fff', borderRadius: 6, width: 22, height: 22,
  cursor: 'pointer', color: '#5A5245', fontSize: 13, lineHeight: 1, padding: 0,
};

function useChatTick() {
  const chat = getChat();
  return useSyncExternalStore(
    (cb) => chat.subscribe(cb),
    () => chat.messages.length + (chat.busy ? 1e6 : 0),
  );
}

function useSettingsTick() {
  return useSyncExternalStore(onSettingsChange, () => JSON.stringify(getSettings()));
}

export function ChatPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  useChatTick();
  useSettingsTick();
  const chat = getChat();
  const settings = getSettings();
  const vs = settings.perVendor[settings.vendor];

  const [text, setText] = useState('');
  const [images, setImages] = useState<ChatImage[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 新消息时滚到底部
  const count = chat.messages.length;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, chat.busy]);

  const send = () => {
    if (!text.trim() && !images.length) return;
    setNote(null);
    void chat.send(text, images);
    setText('');
    setImages([]);
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setNote(null);
    const room = MAX_IMAGES_PER_TURN - images.length;
    if (room <= 0) { setNote(`一轮最多 ${MAX_IMAGES_PER_TURN} 张图片`); return; }
    const picked = [...files].slice(0, room);
    if (files.length > room) setNote(`一轮最多 ${MAX_IMAGES_PER_TURN} 张图片，多出的没有添加`);
    setUploading(true);
    try {
      const next: ChatImage[] = [];
      for (const f of picked) next.push(await compressImage(f));
      setImages((cur) => [...cur, ...next]);
    } catch {
      setNote('图片处理失败，换一张试试');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const busy = chat.busy;
  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy) send();
    }
  };

  return (
    <aside style={{ width: 264, flexShrink: 0, borderRight: '1px solid #DDD6C6', background: '#F8F5EE', display: 'flex', flexDirection: 'column' }} data-testid="chat-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid #E7E1D2' }}>
        <strong style={{ fontSize: 12.5, flex: 1 }}>对话</strong>
        <span style={{ fontSize: 11, color: '#8A8172', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={`${VENDORS[settings.vendor].label} · ${vs.model || '未填模型名'}`}>
          {VENDORS[settings.vendor].label.split('（')[0]} · {vs.model || '未设模型'}
        </span>
        <button onClick={onOpenSettings} style={flatBtn} title="模型服务设置">⚙</button>
      </div>

      {/* 消息流 */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!chat.messages.length && (
          <div style={{ fontSize: 12.5, color: '#8A8172', lineHeight: 1.9, padding: '6px 4px' }}>
            描述想改的地方，AI 会先给出“试看”效果：
            <br />· “客厅加宽 30 厘米”
            <br />· “沙发换成灰色”
            <br />· “看看卧室的 3D 效果”
            <br />也可以问问题，比如“客厅多大”。
          </div>
        )}
        {chat.messages.map((m) => {
          if (m.role === 'user') {
            return (
              <div key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '92%' }} data-testid="chat-user">
                <div style={{ background: '#E7DFC9', borderRadius: 10, padding: '6px 10px', fontSize: 12.5, color: '#3A342B', whiteSpace: 'pre-wrap' }}>
                  {m.text}{m.images.length ? `\n[图片 ${m.images.length} 张]` : ''}
                </div>
                {!!m.images.length && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 3, justifyContent: 'flex-end' }}>
                    {m.images.map((im, i) => <img key={i} src={im.dataUrl} alt={im.name} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 5, border: '1px solid #D8D2C4' }} />)}
                  </div>
                )}
              </div>
            );
          }
          if (m.role === 'assistant') {
            const names = m.toolCalls.map((t) => t.name === 'propose_design_changes' ? '提交修改' : t.name === 'view_action' ? '视图操作' : t.name).join('、');
            return (
              <div key={m.id} style={{ alignSelf: 'flex-start', maxWidth: '92%' }} data-testid="chat-assistant">
                {m.text && <div style={{ background: '#fff', border: '1px solid #E7E1D2', borderRadius: 10, padding: '6px 10px', fontSize: 12.5, color: '#3A342B', whiteSpace: 'pre-wrap' }}>{m.text}</div>}
                {!!m.toolCalls.length && <div style={{ fontSize: 11, color: '#B0A99B', marginTop: 2 }}>{names}</div>}
              </div>
            );
          }
          if (m.role === 'status') {
            return (
              <div key={m.id} style={{
                alignSelf: 'stretch', fontSize: 12, padding: '6px 10px', borderRadius: 8, whiteSpace: 'pre-wrap',
                background: m.level === 'error' ? '#FBEDEB' : '#EFEAE0',
                color: m.level === 'error' ? '#7A2E24' : '#6B6459',
              }} data-testid="chat-status">{m.text}</div>
            );
          }
          // 工具结果只发给模型，不在界面上重复显示（差异列表已由 status 显示）
          return null;
        })}
        {busy && (
          <div style={{ alignSelf: 'flex-start', fontSize: 12, color: '#8A8172', padding: '2px 4px' }} data-testid="chat-busy">
            正在思考…
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div style={{ padding: 10, borderTop: '1px solid #E7E1D2' }}>
        {note && <div style={{ fontSize: 11.5, color: '#A05A4E', marginBottom: 5 }}>{note}</div>}
        {!!images.length && (
          <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
            {images.map((im, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={im.dataUrl} alt={im.name} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 5, border: '1px solid #D8D2C4', display: 'block' }} />
                <button onClick={() => setImages((cur) => cur.filter((_, k) => k !== i))}
                  style={{ position: 'absolute', top: -5, right: -5, width: 15, height: 15, borderRadius: 8, border: 'none', background: '#7A2E24', color: '#fff', fontSize: 10, cursor: 'pointer', lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          data-testid="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyDown}
          placeholder={vs.model ? '描述修改或提问，Enter 发送' : '先点右上角设置选择模型'}
          rows={3}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'none', padding: '7px 10px', borderRadius: 8, border: '1px solid #D8D2C4', background: '#fff', fontSize: 12.5, color: '#3A342B', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <button onClick={() => fileRef.current?.click()} disabled={busy || uploading}
            title={vs.supportsImages ? `附带参考图（最多 ${MAX_IMAGES_PER_TURN} 张）` : '当前模型不支持图片输入，可到设置里更换'}
            style={{ ...flatBtn, width: 'auto', padding: '3px 10px', fontSize: 12, opacity: vs.supportsImages ? 1 : 0.5 }}>+ 图片</button>
          <span style={{ fontSize: 11, color: '#B0A99B', flex: 1 }}>
            {images.length}/{MAX_IMAGES_PER_TURN}
            {uploading ? ' 处理中…' : ''}
          </span>
          {busy
            ? <button onClick={() => chat.stop()} style={{ ...flatBtn, width: 'auto', padding: '4px 14px', fontSize: 12.5, background: '#F6D5D5', borderColor: '#E4C4BE', color: '#7A2E24' }} data-testid="chat-stop">停止</button>
            : <button onClick={send} disabled={(!text.trim() && !images.length) || uploading}
              style={{ ...flatBtn, width: 'auto', padding: '4px 14px', fontSize: 12.5, background: (!text.trim() && !images.length) ? '#EFEAE0' : '#E7DFC9' }} data-testid="chat-send">发送</button>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void attach(e.target.files); }} />
      </div>
    </aside>
  );
}
