// 厂商适配（方案 10.1、10.5）：四家 + 自定义都用 OpenAI 兼容的 chat/completions。
// 不发送 tool_choice；错误按 10.5 的表映射成中文说明；密钥只进请求头，绝不进日志或错误信息。
import { toolDefinitions } from './prompt';
import type { ApiError, CallResult, ModelReply, WireMsg } from './types';

export type VendorId = 'deepseek' | 'qwen' | 'glm' | 'openai' | 'custom';

export interface VendorInfo {
  id: VendorId;
  label: string;
  baseUrl: string;          // 默认服务地址（可改）
  model: string;            // 默认模型名（可改；空串表示需要用户填写）
  modelHint?: string;       // 模型名为空时的提示
  supportsImages: boolean;  // 默认是否按“支持图片”对待（M4 实测后可在设置里改）
}

export const VENDORS: Record<VendorId, VendorInfo> = {
  deepseek: { id: 'deepseek', label: 'DeepSeek（默认）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', supportsImages: false },
  qwen: {
    id: 'qwen', label: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '', supportsImages: false,
    modelHint: '请到百炼控制台复制支持工具调用的模型名（如 qwen-max / qwen-plus）',
  },
  glm: { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3', supportsImages: false },
  openai: {
    id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', supportsImages: true,
    modelHint: '请填写支持工具调用的模型名（如 gpt-4o）',
  },
  custom: { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', supportsImages: false },
};

export const VENDOR_IDS = Object.keys(VENDORS) as VendorId[];

/** 解析后的当前配置：厂商默认值 + 用户设置合并的结果 */
export interface ResolvedConfig {
  vendor: VendorId;
  baseUrl: string;
  model: string;
  apiKey: string;
  supportsImages: boolean;
}

export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 按 error.message → message → 原始文本 的顺序读取错误内容（兼容 GLM） */
export function extractErrorText(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown; code?: unknown }; message?: unknown };
    const m = j?.error?.message ?? j?.message;
    if (typeof m === 'string' && m) return m;
    const code = j?.error?.code;
    if (typeof code === 'string' && code) return code;
  } catch { /* 非 JSON，走原文 */ }
  const t = body.trim();
  return t ? t.slice(0, 300) : undefined;
}

/** 方案 10.5 错误表（分类扫描完整回包，展示用提取出的错误说明） */
export function mapHttpError(status: number, body: string): ApiError {
  const detail = extractErrorText(body);
  const raw = body.toLowerCase();
  if (status === 401 || status === 403) return { kind: 'auth', message: '密钥无效或已过期，请检查', detail };
  if (status === 404 || raw.includes('model_not_found') || raw.includes('model not found')) {
    return { kind: 'model', message: '模型名称不对（也可能是服务地址不对），请到厂商控制台核对', detail };
  }
  if (status === 400) {
    if (/image|multimodal|vision/.test(raw)) return { kind: 'image', message: '该模型不支持图片输入，请换支持视觉的模型，或去掉图片再发', detail };
    if (/tool|function/.test(raw)) return { kind: 'tools', message: '该模型不支持工具调用，请换一个模型', detail };
  }
  if (status === 429) {
    if (raw.includes('insufficient_quota')) return { kind: 'quota', message: '额度不足，请到厂商控制台处理后再试', detail };
    return { kind: 'quota', message: '请求太频繁，请稍后再试', detail };
  }
  if (status >= 500) return { kind: 'server', message: '服务暂时不可用，请稍后再试', detail };
  return { kind: 'http', message: `请求失败（${status}）`, detail };
}

/** 解析正常回包：choices[0].message 的文字与工具调用 */
export function parseReply(body: unknown): ModelReply | null {
  const choice = (body as { choices?: { message?: unknown }[] })?.choices?.[0];
  const msg = choice?.message;
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { content?: unknown; tool_calls?: unknown };
  const text = typeof m.content === 'string' ? m.content : '';
  const toolCalls: ModelReply['toolCalls'] = [];
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function;
      if (!fn || typeof fn.name !== 'string') continue;
      const args = fn.arguments;
      toolCalls.push({
        id: typeof (tc as { id?: unknown }).id === 'string' ? (tc as { id: string }).id : `call_${toolCalls.length}`,
        name: fn.name,
        argsJson: typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args),
      });
    }
  }
  if (!text && !toolCalls.length) return null;
  return { text, toolCalls };
}

export interface CallOptions {
  /** null 表示这次不带工具（比如让模型只解释原因） */
  tools?: unknown[] | null;
  maxTokens?: number;
  timeoutMs?: number;
  /** 用户点“停止”时的外部信号 */
  signal?: AbortSignal;
  temperature?: number;
}

/** 一次 chat/completions 调用。密钥只进 Authorization 头；错误信息里不包含请求头 */
export async function chatCompletion(cfg: ResolvedConfig, messages: WireMsg[], opts: CallOptions = {}): Promise<CallResult> {
  if (!cfg.apiKey) return { ok: false, error: { kind: 'missingKey', message: '请先在设置中填写 API Key' } };
  if (!cfg.baseUrl) return { ok: false, error: { kind: 'http', message: '请先在设置中填写服务地址' } };
  if (!cfg.model) return { ok: false, error: { kind: 'model', message: '请先在设置中填写模型名称' } };

  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.3,
    stream: false,
  };
  const tools = opts.tools === undefined ? toolDefinitions() : opts.tools;
  if (tools) payload.tools = tools;
  if (opts.maxTokens) payload.max_tokens = opts.maxTokens;

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeoutMs ?? 60_000);
  const onUserStop = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onUserStop);
  try {
    const res = await fetch(chatUrl(cfg.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, error: mapHttpError(res.status, body) };
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return { ok: false, error: { kind: 'parse', message: '服务返回的内容无法解析', detail: body.slice(0, 300) } }; }
    const reply = parseReply(parsed);
    if (!reply) return { ok: false, error: { kind: 'parse', message: '服务返回的内容无法解析', detail: body.slice(0, 300) } };
    return { ok: true, reply };
  } catch (e) {
    if (opts.signal?.aborted) return { ok: false, error: { kind: 'aborted', message: '已停止' } };
    if (timedOut) return { ok: false, error: { kind: 'timeout', message: '等待超时，可重试' } };
    return { ok: false, error: { kind: 'network', message: '网络不通或被拦截，请检查网络' } };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onUserStop);
  }
}

/** 测试连接（方案 10.5）：最小请求 + 一个空工具 + 词元上限 512。
 *  上限不是消耗量：思考型模型（如 deepseek-flash）先输出 reasoning_content 再答复，
 *  实测 16 个词元会全部耗在思考上（finish_reason=length、content 为空），512 才轮得到正文。 */
export async function testConnection(cfg: ResolvedConfig, signal?: AbortSignal): Promise<{ ok: boolean; message: string; detail?: string }> {
  const emptyTool = [{
    type: 'function',
    function: {
      name: 'connection_test_noop',
      description: '测试连接用的空工具，不需要调用',
      parameters: { type: 'object', properties: {} },
    },
  }];
  const r = await chatCompletion(cfg, [{ role: 'user', content: '测试连接' }], {
    tools: emptyTool, maxTokens: 512, timeoutMs: 30_000, signal,
  });
  if (r.ok) return { ok: true, message: '连接成功：地址、密钥、模型名可用，且接受工具参数' };
  return { ok: false, message: r.error.message, detail: r.error.detail };
}
