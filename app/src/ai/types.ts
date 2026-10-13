// AI 对话层的共享类型（方案第 10 节）。
// 消息模型：界面显示用 ChatMessage（含仅展示的 status），发给厂商的格式用 WireMsg。

/** 一张用户附带的图片：浏览器里压缩后以 data URL 保存，不落盘、不导出（需求 7.4） */
export interface ChatImage { name: string; dataUrl: string }

/** 模型返回的工具调用（arguments 是厂商回包里的原始 JSON 字符串） */
export interface ToolCall { id: string; name: string; argsJson: string }

/** 对话记录的一页。status 是程序生成的提示（如“已应用”），只显示，不发给模型 */
export type ChatMessage =
  | { id: string; role: 'user'; text: string; images: ChatImage[] }
  | { id: string; role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { id: string; role: 'tool'; toolCallId: string; name: string; content: string }
  | { id: string; role: 'status'; text: string; level: 'info' | 'error' };

/** 发给厂商的 OpenAI 兼容消息格式 */
export type WireMsg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WireContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** 多模态用户消息的一个部分：文字或图片 */
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** 一次模型调用的正常返回 */
export interface ModelReply { text: string; toolCalls: ToolCall[] }

/** 一次模型调用的失败（方案 10.5 错误表） */
export interface ApiError {
  kind: 'missingKey' | 'auth' | 'model' | 'tools' | 'image' | 'quota' | 'server' | 'timeout' | 'network' | 'aborted' | 'parse' | 'http';
  message: string; // 给用户看的中文说明
  detail?: string; // 厂商返回的原始错误（不含密钥）
}

export type CallResult = { ok: true; reply: ModelReply } | { ok: false; error: ApiError };
