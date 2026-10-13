// 模型服务设置（方案 9.7、10.1）：
// 密钥默认只在内存；勾选“记住密钥”才写 localStorage（按厂商分开），并随时可清除；
// 密钥绝不进 IndexedDB、日志、导出包。其余设置（地址、模型名、是否支持图片）直接记住。
import { VENDORS, VENDOR_IDS, type ResolvedConfig, type VendorId } from './vendors';

const SETTINGS_KEY = 'rd:model-settings';
const apiKeyStorage = (v: VendorId) => `rd:api-key:${v}`;

export interface VendorSettings {
  baseUrl: string;
  model: string;
  supportsImages: boolean;
  rememberKey: boolean;
}

export interface ModelSettings {
  vendor: VendorId;
  perVendor: Record<VendorId, VendorSettings>;
}

function defaultSettings(): ModelSettings {
  const perVendor = {} as Record<VendorId, VendorSettings>;
  for (const id of VENDOR_IDS) {
    const v = VENDORS[id];
    perVendor[id] = { baseUrl: v.baseUrl, model: v.model, supportsImages: v.supportsImages, rememberKey: false };
  }
  return { vendor: 'deepseek', perVendor };
}

const hasLS = () => typeof localStorage !== 'undefined';

export function loadSettings(): ModelSettings {
  if (!hasLS()) return defaultSettings();
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<ModelSettings> | null;
    if (!raw || !raw.vendor || !VENDOR_IDS.includes(raw.vendor)) return defaultSettings();
    const s = defaultSettings();
    s.vendor = raw.vendor;
    for (const id of VENDOR_IDS) {
      const saved = raw.perVendor?.[id];
      if (saved) s.perVendor[id] = { ...s.perVendor[id], ...saved, rememberKey: false };
    }
    // 勾选过“记住密钥”的厂商，启动时把密钥从 localStorage 读回内存
    for (const id of VENDOR_IDS) {
      const flag = localStorage.getItem(`${apiKeyStorage(id)}:remember`);
      if (flag === '1') s.perVendor[id].rememberKey = true;
    }
    return s;
  } catch {
    return defaultSettings();
  }
}

/** 内存里的密钥（不落盘的部分） */
const memoryKeys = new Map<VendorId, string>();

export function setApiKey(v: VendorId, key: string, settings: ModelSettings): void {
  memoryKeys.set(v, key);
  const vs = settings.perVendor[v];
  if (vs.rememberKey && hasLS()) {
    localStorage.setItem(apiKeyStorage(v), key);
    localStorage.setItem(`${apiKeyStorage(v)}:remember`, '1');
  } else {
    clearStoredKey(v);
  }
}

export function getApiKey(v: VendorId): string {
  return memoryKeys.get(v) ?? (hasLS() && localStorage.getItem(`${apiKeyStorage(v)}:remember`) === '1'
    ? localStorage.getItem(apiKeyStorage(v)) ?? ''
    : '');
}

function clearStoredKey(v: VendorId): void {
  if (!hasLS()) return;
  localStorage.removeItem(apiKeyStorage(v));
  localStorage.removeItem(`${apiKeyStorage(v)}:remember`);
}

/** 切换“记住密钥”：勾上时写入，取消时清除本机存储 */
export function setRememberKey(v: VendorId, remember: boolean, settings: ModelSettings): void {
  settings.perVendor[v].rememberKey = remember;
  if (remember) {
    const key = memoryKeys.get(v) ?? '';
    if (hasLS() && key) { localStorage.setItem(apiKeyStorage(v), key); localStorage.setItem(`${apiKeyStorage(v)}:remember`, '1'); }
  } else {
    clearStoredKey(v);
  }
}

export function saveSettings(s: ModelSettings): void {
  if (!hasLS()) return;
  const perVendor = {} as Record<VendorId, VendorSettings>;
  for (const id of VENDOR_IDS) perVendor[id] = { ...s.perVendor[id] }; // rememberKey 不持久化，由密钥的 remember 标记推断
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ vendor: s.vendor, perVendor }));
}

/** “忘记所有密钥”：清除内存与本机存储 */
export function forgetAllKeys(): void {
  memoryKeys.clear();
  for (const id of VENDOR_IDS) clearStoredKey(id);
}

/** 合成当前生效的配置（发给厂商用） */
export function resolveConfig(s: ModelSettings): ResolvedConfig {
  const v = s.perVendor[s.vendor];
  return { vendor: s.vendor, baseUrl: v.baseUrl, model: v.model, apiKey: getApiKey(s.vendor), supportsImages: v.supportsImages };
}
