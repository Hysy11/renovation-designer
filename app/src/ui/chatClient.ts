// 对话控制器与界面之间的接线（单例）：
// host 把 propose/view 落到状态层的动作上；设置（厂商/密钥）在这里集中管理。
// ai 层保持纯逻辑（方案 2.2），所有对 store 的访问都发生在这个 UI 层文件里。
import { ChatController, type ChatHost, type ProposeResult, type ViewResult } from '../ai/agent';
import { chatCompletion, type ResolvedConfig, type VendorId } from '../ai/vendors';
import {
  forgetAllKeys, getApiKey, loadSettings, resolveConfig, saveSettings,
  setApiKey as persistApiKey, setRememberKey, type ModelSettings,
} from '../ai/settings';
import { getStore, actions } from './useApp';
import { can, proposeConflicts } from '../store/designStore';
import type { Op } from '../engine/ops';
import type { Issue } from '../geometry/validate';
import type { Design } from '../model/schema';

// ---------- 设置状态（模块级单例 + 变更通知，供 React 订阅） ----------

let settings: ModelSettings | null = null;
const listeners = new Set<() => void>();

export function getSettings(): ModelSettings {
  if (!settings) settings = loadSettings();
  return settings;
}

export function updateSettings(fn: (s: ModelSettings) => void): void {
  fn(getSettings());
  saveSettings(getSettings());
  for (const l of listeners) l();
}

export function onSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setVendorApiKey(v: VendorId, key: string): void {
  updateSettings(() => persistApiKey(v, key, getSettings()));
}

export function setVendorRemember(v: VendorId, remember: boolean): void {
  updateSettings(() => setRememberKey(v, remember, getSettings()));
}

export function forgetKeys(): void {
  forgetAllKeys();
  for (const l of listeners) l();
}

/** 用对话框里（可能尚未保存）的值构造配置，供“测试连接” */
export function buildConfig(v: VendorId, baseUrl: string, model: string, apiKey: string, supportsImages: boolean): ResolvedConfig {
  return { vendor: v, baseUrl, model, apiKey, supportsImages };
}

export function currentApiKey(v: VendorId): string { return getApiKey(v); }

// ---------- host：把工具调用落到状态层 ----------

const fmtIssue = (i: Issue) => `${i.message}${i.hint ? `（${i.hint}）` : ''}`;

/** 每轮请求组装时的设计快照；propose 落地时用它判断“等待期间设计是否被手动改过”（方案 10.4） */
let promptDesign: Design | null = null;

const host: ChatHost = {
  config: () => resolveConfig(getSettings()),

  promptContext: () => {
    const s = getStore().getState();
    promptDesign = s.design;
    const sel = s.session.selection;
    const o = s.session.overlay;
    return {
      design: s.design,
      selection: sel ? `${sel.kind}:${sel.id}` : null,
      page: s.session.page,
      mode: s.session.mode,
      trial: o.type === 'trial' ? { summary: o.summary, opsJson: JSON.stringify(o.ops) } : null,
    };
  },

  callModel: (cfg, messages, opts) => chatCompletion(cfg, messages, opts),

  propose: (ops, summary): ProposeResult => {
    const s = getStore().getState();
    const o = s.session.overlay;
    if (o.type === 'history') {
      return { ok: false, message: can(s, 'chatPropose').reason ?? '正在查看历史版本，提出的修改需要先退出查看' };
    }
    // 方案 10.4：模型思考期间设计被手动改过、且提议撞上被改的对象/字段时，不生成试看；
    // 回传后模型会带着最新快照重试
    if (promptDesign && s.design !== promptDesign && proposeConflicts(promptDesign, s.design, ops)) {
      return { ok: false, message: '设计在等待期间已变化，这份提议与等待期间的手动修改冲突，未生成试看。请基于最新设计快照重新提议' };
    }
    // 试看中 → 继续调整（整体替换当前试看）；否则发起新试看
    const r = o.type === 'trial' ? actions().reviseTrial(ops as Op[], summary) : actions().startTrial('ai', ops as Op[], summary);
    if (!r.ok) return { ok: false, message: r.message, errors: (r.errors ?? []).map(fmtIssue) };
    return { ok: true, message: r.message, changes: (r.result?.changes ?? []).map((c) => c.text) };
  },

  view: (action, target): ViewResult => {
    const s = getStore().getState();
    const a = actions();
    switch (action) {
      case 'focus_room': {
        const t = (target ?? '').trim();
        // “整个家/全屋”取景：真实样例实测发现模型说“俯视整个家”时需要能从单间切回全屋（2026-10-13）
        if (!t || t === 'house' || t === '全屋' || t === '整个家') {
          a.setPage('3d');
          a.setView3d({ scope: 'house' });
          return { ok: true, message: '已回到全屋取景' };
        }
        const room = s.design.rooms.find((r) => r.id === t || r.name === t);
        if (!room) return { ok: false, message: `没有找到房间「${t}」，请用设计快照里的房间编号，或传 house 回到全屋` };
        a.setPage('3d');
        a.setView3d({ scope: { roomId: room.id } });
        a.select({ kind: 'room', id: room.id });
        return { ok: true, message: `已在 3D 中聚焦「${room.name}」` };
      }
      case 'top_view':
        a.setPage('3d');
        a.setView3d({ camCmd: { kind: 'top', n: s.session.view3d.camCmd.n + 1 } });
        return { ok: true, message: '已切换到俯视' };
      case 'reset_view':
        a.setPage('3d');
        a.setView3d({ camCmd: { kind: 'reset', n: s.session.view3d.camCmd.n + 1 } });
        return { ok: true, message: '已恢复默认视角' };
      case 'highlight': {
        if (!target) return { ok: false, message: '缺少要高亮的对象编号' };
        const f = s.design.furniture.find((x) => x.id === target);
        if (f) { a.select({ kind: 'furniture', id: f.id }); return { ok: true, message: `已选中家具「${f.name}」` }; }
        const r = s.design.rooms.find((x) => x.id === target);
        if (r) { a.select({ kind: 'room', id: r.id }); return { ok: true, message: `已选中房间「${r.name}」` }; }
        const o = s.design.openings.find((x) => x.id === target);
        if (o) { a.select({ kind: 'opening', id: o.id }); return { ok: true, message: '已选中门窗' }; }
        if (/^(ext:|shared:)/.test(target)) { a.select({ kind: 'wall', id: target }); return { ok: true, message: '已选中墙段' }; }
        return { ok: false, message: `没有找到对象「${target}」，请用设计快照里的编号` };
      }
      case 'switch_page':
        if (target !== 'plan' && target !== '3d') return { ok: false, message: '页面只能是 plan 或 3d' };
        a.setPage(target);
        return { ok: true, message: target === '3d' ? '已切换到 3D' : '已切换到平面图' };
      case 'toggle_cutaway':
        a.setPage('3d');
        a.setView3d({ cutaway: !s.session.view3d.cutaway });
        return { ok: true, message: s.session.view3d.cutaway ? '已关闭剖面' : '已开启剖面' };
      default:
        return { ok: false, message: `未知操作 ${action}` };
    }
  },
};

// ---------- 对话控制器单例 ----------

let chat: ChatController | null = null;

export function getChat(): ChatController {
  if (!chat) chat = new ChatController(host);
  return chat;
}
