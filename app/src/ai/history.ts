// 历史消息裁剪与格式转换（方案 10.3）：
// 最近 10 轮、总字数约 2.4 万（超出时从最早一轮整轮删除）；
// 工具调用与工具结果永远成对保留；裁剪后必须以用户消息开头；
// 历史中最多保留最近 6 张图片，更早的替换为「[图片已省略]」占位。
import type { ChatImage, ChatMessage, WireContentPart, WireMsg } from './types';

export const MAX_ROUNDS = 10;
export const MAX_HISTORY_CHARS = 24_000;
export const MAX_HISTORY_IMAGES = 6;

interface Round {
  user?: Extract<ChatMessage, { role: 'user' }>;
  rest: ChatMessage[]; // 该轮里 user 之后的所有消息（assistant / tool）
}

/** 按用户消息把历史分轮 */
function roundsOf(messages: ChatMessage[]): Round[] {
  const rounds: Round[] = [];
  for (const m of messages) {
    if (m.role === 'status') continue; // 程序提示只显示，不发给模型
    if (m.role === 'user') { rounds.push({ user: m, rest: [] }); continue; }
    const cur = rounds.at(-1);
    if (cur) cur.rest.push(m); // 开头没有 user 的零散消息（理论不该有）丢弃
  }
  return rounds;
}

function imageParts(text: string, images: ChatImage[]): WireContentPart[] {
  const parts: WireContentPart[] = [{ type: 'text', text: text || '（见图片）' }];
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  return parts;
}

function roundChars(r: Round): number {
  let n = (r.user?.text.length ?? 0);
  for (const m of r.rest) {
    if (m.role === 'assistant') n += m.text.length + m.toolCalls.reduce((s, t) => s + t.argsJson.length, 0);
    else if (m.role === 'tool') n += m.content.length;
  }
  return n;
}

/**
 * 把对话记录转成发给厂商的消息数组（不含系统消息）。
 * 图片按“从最新往前数 6 张”保留，超出的替换成占位文字。
 */
export function buildWireHistory(messages: ChatMessage[]): WireMsg[] {
  let rounds = roundsOf(messages).slice(-MAX_ROUNDS);
  // 超出字数时从最早一轮整轮删除（至少保留最近一轮）
  while (rounds.length > 1 && rounds.reduce((s, r) => s + roundChars(r), 0) > MAX_HISTORY_CHARS) {
    rounds = rounds.slice(1);
  }

  // 图片预算：从最新往前数；超出预算的整块换成占位文字
  let imageBudget = MAX_HISTORY_IMAGES;
  const kept = rounds.slice().reverse().map((r) => {
    if (!r.user) return { r, dropped: 0 };
    const total = r.user.images.length;
    const keep = Math.min(imageBudget, total);
    imageBudget -= keep;
    if (keep === total) return { r, dropped: 0 };
    return { r: { ...r, user: { ...r.user, images: r.user.images.slice(0, keep) } }, dropped: total - keep };
  }).reverse();

  const out: WireMsg[] = [];
  for (const { r, dropped } of kept) {
    if (!r.user) continue;
    const text = dropped > 0 ? `${r.user.text}\n[图片已省略 ${dropped} 张]` : r.user.text;
    out.push(r.user.images.length ? { role: 'user', content: imageParts(text, r.user.images) } : { role: 'user', content: text });
    for (const m of r.rest) {
      if (m.role === 'assistant') {
        out.push({
          role: 'assistant',
          content: m.text || null,
          ...(m.toolCalls.length ? {
            tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.argsJson } })),
          } : {}),
        });
      } else if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      }
    }
  }
  return out;
}

/** 裁剪后还剩几轮（给界面显示“模型能记得最近 N 轮”） */
export function historyRoundCount(messages: ChatMessage[]): number {
  return roundsOf(messages).slice(-MAX_ROUNDS).length;
}
