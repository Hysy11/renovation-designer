// 一次对话的流程控制（方案 10.4）：
// 用户发送 → 组装请求（每轮都带最新设计快照）→ 调用模型（最多 4 次、60 秒超时、可停止）
// → 文字回答直接显示；view_action 立即执行并回传结果；
// → propose_design_changes 用引擎试执行，通过则生成试看并结束本轮（不再调模型），
//   失败则把错误回传自动重试（最多 2 次），仍失败再请求一次让模型向用户解释。
// ai 层只通过 host 注入的 propose/view 影响设计和界面，自身不改状态（方案 2.2）。
import { buildSystemPrompt, TOOL_PROPOSE, TOOL_VIEW, type PromptContext } from './prompt';
import { buildWireHistory } from './history';
import type { CallResult, ChatImage, ChatMessage, ToolCall, WireMsg } from './types';
import type { ResolvedConfig } from './vendors';

export const MAX_MODEL_CALLS = 4;      // 一次用户发送最多调用模型的次数（方案 10.4）
export const MAX_PROPOSE_RETRIES = 2;  // 修改被拒绝后的自动重试次数

export interface ProposeResult {
  ok: boolean;
  message: string;
  /** 引擎检查的错误列表（原因+建议，回传给模型） */
  errors?: string[];
  /** 程序生成的差异列表（成功时在对话里显示） */
  changes?: string[];
}

export interface ViewResult { ok: boolean; message: string }

/** 对话控制依赖的外部能力：由界面层接线，测试里用假实现 */
export interface ChatHost {
  config(): ResolvedConfig;
  promptContext(): PromptContext;
  callModel(cfg: ResolvedConfig, messages: WireMsg[], opts: { tools?: unknown[] | null; signal?: AbortSignal }): Promise<CallResult>;
  /** 提交修改：内部决定 startTrial 还是 reviseTrial（试看中的继续调整） */
  propose(ops: unknown[], summary: string): ProposeResult;
  view(action: string, target?: string): ViewResult;
}

let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

export class ChatController {
  messages: ChatMessage[] = [];
  busy = false;
  private stopSignal: AbortController | null = null;
  private lastTrialOutcome: string | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly host: ChatHost) {}

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const fn of this.listeners) fn(); }
  private push(m: ChatMessage) { this.messages.push(m); this.emit(); }

  stop() { this.stopSignal?.abort(); }

  /** 重新生成：把最近一条用户消息原样再发一次（试看过期后的“重新生成”，AI-07） */
  async resendLast(): Promise<void> {
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
    if (lastUser && lastUser.role === 'user') await this.send(lastUser.text, lastUser.images);
  }

  /** 程序生成的提示（应用/放弃/过期等），只显示，不发给模型 */
  noteStatus(text: string, level: 'info' | 'error' = 'info') { this.push({ id: nextId('s_'), role: 'status', text, level }); }

  /** 试看的处理结果：显示给用户，并带入下一轮请求（方案 17 节第 1 条） */
  noteTrialOutcome(text: string) { this.lastTrialOutcome = text; this.noteStatus(text); }

  async send(text: string, images: ChatImage[] = []): Promise<void> {
    if (this.busy) return;
    const t = text.trim();
    if (!t && !images.length) return;
    const cfg = this.host.config();
    this.push({ id: nextId('u_'), role: 'user', text: t, images });
    // 不支持的组合不发空请求（方案 10.3）
    if (images.length && !cfg.supportsImages) {
      this.push({ id: nextId('s_'), role: 'status', level: 'error', text: '该模型不支持图片输入，请换支持视觉的模型，或去掉图片再发' });
      return;
    }
    this.busy = true;
    const stop = new AbortController();
    this.stopSignal = stop;
    this.emit();
    try {
      await this.turn(cfg, stop.signal);
    } finally {
      this.busy = false;
      this.stopSignal = null;
      this.emit();
    }
  }

  private async turn(cfg: ResolvedConfig, signal: AbortSignal): Promise<void> {
    let proposeFails = 0;    // 修改提议被拒（含参数解析失败）的次数
    let explainOnly = false; // 重试用尽后，最后一步不带工具，让模型向用户解释
    let calls = 0;

    while (calls < MAX_MODEL_CALLS) {
      const system = buildSystemPrompt({
        ...this.host.promptContext(),
        lastTrialOutcome: this.lastTrialOutcome,
        supportsImages: cfg.supportsImages,
      });
      const r = await this.host.callModel(cfg, [{ role: 'system', content: system }, ...buildWireHistory(this.messages)], {
        tools: explainOnly ? null : undefined,
        signal,
      });
      calls++;
      if (!r.ok) {
        this.push({ id: nextId('s_'), role: 'status', level: 'error', text: r.error.kind === 'aborted' ? '已停止' : r.error.message });
        return;
      }

      const { text, toolCalls } = r.reply;
      this.push({ id: nextId('a_'), role: 'assistant', text, toolCalls });
      if (!toolCalls.length) {
        if (!text) this.push({ id: nextId('s_'), role: 'status', level: 'info', text: '模型没有返回内容' });
        return; // 纯文字回答，本轮结束
      }
      if (explainOnly) {
        // 不带工具的最后一次调用仍试图调用工具：回传后结束，不再执行
        for (const tc of toolCalls) {
          this.push({ id: nextId('t_'), role: 'tool', toolCallId: tc.id, name: tc.name, content: '本轮已停止提交修改，请直接向用户说明' });
        }
        return;
      }

      let trialStarted = false;
      let proposeSeen = false; // 一次回复只采用第一份修改提议（方案 10.4）
      for (const tc of toolCalls) {
        const out = this.runTool(tc, () => {
          if (proposeSeen) return true;
          proposeSeen = true;
          return false;
        }, () => proposeFails, (n) => { proposeFails = n; if (proposeFails > MAX_PROPOSE_RETRIES) explainOnly = true; });
        if (out.trialStarted) trialStarted = true;
        this.push({ id: nextId('t_'), role: 'tool', toolCallId: tc.id, name: tc.name, content: out.content });
      }

      if (trialStarted) return; // 试看成功后不再额外调用模型（方案 10.4）
      if (explainOnly && calls >= MAX_MODEL_CALLS) {
        this.push({ id: nextId('s_'), role: 'status', level: 'error', text: '多次尝试都未能生成合法的修改，请换个说法，或先手动调整' });
        return;
      }
    }
    this.push({ id: nextId('s_'), role: 'status', level: 'info', text: '已达到本轮对话的调用上限，请继续发送消息' });
  }

  /** 执行一个工具调用，返回要回传给模型的文字 */
  private runTool(
    tc: ToolCall,
    claimPropose: () => boolean,                 // 返回 true 表示本回复里已经有一份提议，这条跳过
    getFails: () => number, setFails: (n: number) => void,
  ): { content: string; trialStarted?: boolean } {
    if (tc.name === TOOL_VIEW) {
      let action = '', target: string | undefined;
      try {
        const a = JSON.parse(tc.argsJson || '{}') as { action?: unknown; target?: unknown };
        action = typeof a.action === 'string' ? a.action : '';
        target = typeof a.target === 'string' ? a.target : undefined;
      } catch { /* 参数不合法时按缺少 action 处理 */ }
      if (!action) return { content: '参数格式不正确：缺少 action' };
      const v = this.host.view(action, target);
      return { content: v.ok ? `已执行：${v.message}` : `未执行：${v.message}` };
    }

    if (tc.name === TOOL_PROPOSE) {
      if (claimPropose()) return { content: '一次只能提交一份修改，这条没有执行' };
      let summary = '', ops: unknown[] = [];
      try {
        const a = JSON.parse(tc.argsJson || '{}') as { summary?: unknown; ops?: unknown };
        summary = typeof a.summary === 'string' ? a.summary : '';
        ops = Array.isArray(a.ops) ? a.ops : [];
        if (!ops.length) throw new Error('ops 不能是空数组');
      } catch (e) {
        setFails(getFails() + 1);
        return { content: `参数格式不正确：${e instanceof Error ? e.message : String(e)}` };
      }
      const p = this.host.propose(ops, summary);
      if (p.ok) {
        const lines = (p.changes ?? []).map((c) => `- ${c}`).join('\n');
        this.push({ id: nextId('s_'), role: 'status', level: 'info', text: `已生成试看（${p.changes?.length ?? 0} 项修改）：\n${lines}` });
        return { content: '已进入试看，等待用户应用或放弃。差异列表已由程序显示给用户。', trialStarted: true };
      }
      const fails = getFails() + 1;
      setFails(fails);
      const errs = p.errors?.length ? p.errors : [p.message];
      let content = `修改未通过检查：\n${errs.join('\n')}`;
      if (fails > MAX_PROPOSE_RETRIES) content += `\n已连续 ${fails} 次未通过检查。请不要再提交修改，直接向用户解释失败原因并给出建议。`;
      return { content };
    }

    return { content: `未知工具 ${tc.name}，只能使用 ${TOOL_PROPOSE} 或 ${TOOL_VIEW}` };
  }
}
