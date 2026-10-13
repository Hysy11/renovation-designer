// 模型服务设置（方案 9.7、10.1）：厂商、地址、模型名、密钥（可记住）、是否支持图片、测试连接。
// 密钥只进内存；勾选“记住密钥”才写 localStorage，并给出明确警示（MODEL-04 的隐私要求）。
import { useEffect, useState } from 'react';
import { testConnection, VENDOR_IDS, VENDORS, type VendorId } from '../ai/vendors';
import { buildConfig, currentApiKey, forgetKeys, getSettings, setVendorApiKey, setVendorRemember, updateSettings } from './chatClient';

const btn = (primary = false): React.CSSProperties => ({
  border: `1px solid ${primary ? '#C25B4E' : '#D8D2C4'}`, background: primary ? '#C25B4E' : '#fff',
  color: primary ? '#fff' : '#5A5245', borderRadius: 8, padding: '6px 16px', fontSize: 12.5, cursor: 'pointer',
});
const fieldLabel: React.CSSProperties = { fontSize: 12, color: '#8A8172', margin: '10px 0 3px' };
const fieldInput: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8,
  border: '1px solid #D8D2C4', background: '#fff', fontSize: 12.5, color: '#3A342B',
};

export function ModelSettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = getSettings();
  const [vendor, setVendor] = useState<VendorId>(settings.vendor);
  const [baseUrl, setBaseUrl] = useState(settings.perVendor[settings.vendor].baseUrl);
  const [model, setModel] = useState(settings.perVendor[settings.vendor].model);
  const [apiKey, setApiKey] = useState(currentApiKey(settings.vendor));
  const [remember, setRemember] = useState(settings.perVendor[settings.vendor].rememberKey);
  const [supportsImages, setSupportsImages] = useState(settings.perVendor[settings.vendor].supportsImages);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; detail?: string } | null>(null);

  const v = VENDORS[vendor];
  useEffect(() => {
    // 切换厂商时载入该厂商的设置
    const vs = getSettings().perVendor[vendor];
    setBaseUrl(vs.baseUrl);
    setModel(vs.model);
    setApiKey(currentApiKey(vendor));
    setRemember(vs.rememberKey);
    setSupportsImages(vs.supportsImages);
    setTestResult(null);
  }, [vendor]);

  const save = () => {
    updateSettings((s) => {
      s.vendor = vendor;
      s.perVendor[vendor] = { ...s.perVendor[vendor], baseUrl, model, supportsImages };
    });
    setVendorApiKey(vendor, apiKey.trim());
    setVendorRemember(vendor, remember);
    onClose();
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testConnection(buildConfig(vendor, baseUrl.trim(), model.trim(), apiKey.trim(), supportsImages));
      setTestResult(r);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(40,35,25,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="model-settings">
      <div style={{ width: 460, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', background: '#FBF8F1', borderRadius: 14, border: '1px solid #D8D2C4', boxShadow: '0 12px 40px rgba(40,35,25,.25)', padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 14, flex: 1 }}>模型服务设置</strong>
          <button onClick={onClose} style={btn()} title="关闭">✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#8A8172', lineHeight: 1.7 }}>
          对话请求由浏览器直接发给所选厂商。密钥默认只保存在内存里，关闭页面即消失。
        </div>

        <div style={fieldLabel}>厂商</div>
        <select value={vendor} onChange={(e) => setVendor(e.target.value as VendorId)} style={{ ...fieldInput, appearance: 'auto' }}>
          {VENDOR_IDS.map((id) => <option key={id} value={id}>{VENDORS[id].label}</option>)}
        </select>

        <div style={fieldLabel}>服务地址</div>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={v.baseUrl || 'https://…'} style={fieldInput} spellCheck={false} />

        <div style={fieldLabel}>模型名称</div>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={v.model || '填写支持工具调用的模型名'} style={fieldInput} spellCheck={false} />
        {v.modelHint && !model.trim() && <div style={{ fontSize: 11.5, color: '#B07840', marginTop: 3 }}>{v.modelHint}</div>}

        <div style={fieldLabel}>API Key</div>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="粘贴厂商控制台生成的密钥" style={fieldInput} spellCheck={false} autoComplete="off" />
        <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 6, fontSize: 12, color: '#5A5245', cursor: 'pointer' }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ marginTop: 2 }} />
          <span>记住密钥（存在本机浏览器中）<br />
            <span style={{ color: '#A05A4E', fontSize: 11.5 }}>密钥未加密，保存在本机浏览器中，能使用这台电脑和浏览器的人或恶意扩展可能读到。</span>
          </span>
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 12, color: '#5A5245', cursor: 'pointer' }}>
          <input type="checkbox" checked={supportsImages} onChange={(e) => setSupportsImages(e.target.checked)} />
          <span>该模型支持图片输入（对话里才能附带参考图）</span>
        </label>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
          <button onClick={() => { void runTest(); }} disabled={testing} style={btn()}>{testing ? '测试中…' : '测试连接'}</button>
          <button onClick={forgetKeys} style={btn()} title="清除本机保存的所有密钥">忘记所有密钥</button>
          <span style={{ flex: 1 }} />
          <button onClick={save} style={btn(true)}>保存</button>
        </div>
        {testResult && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12.5, whiteSpace: 'pre-wrap',
            background: testResult.ok ? '#DCECDC' : '#F6D5D5', color: testResult.ok ? '#3A5A3A' : '#7A2E24',
          }} data-testid="test-connection-result">
            {testResult.message}{testResult.detail ? `\n${testResult.detail}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
