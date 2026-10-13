// 状态层（方案 7.4、8 节）：当前设计、撤销栈、试看/历史查看叠加层、选中对象、保存状态。
// 用 zustand/vanilla 创建，React 组件和 3D 场景都能订阅；测试中可直接调用。
import { createStore } from 'zustand/vanilla';
import type { Design, ObjectRef } from '../model/schema';
import { Design as DesignSchema } from '../model/schema';
import { applyOps, type ApplyResult, type EngineOptions } from '../engine/apply';
import { diffDesigns, type Change } from '../engine/diff';
import type { Op } from '../engine/ops';
import { validateDesign, type Issue } from '../geometry/validate';

export const UNDO_LIMIT = 100;
export const NUDGE_MERGE_MS = 500;

export type Selection = { kind: 'room' | 'wall' | 'opening' | 'furniture'; id: string } | null;

export type Overlay =
  | { type: 'none' }
  | {
      type: 'trial'; source: 'ai' | 'style'; summary: string;
      base: Design; baseRevision: number; ops: Op[];
      candidate: Design; changes: Change[];
      touched: string[];           // 试看要改的“对象:字段”，用于判断冲突
      stale: boolean; staleReason?: string;
    }
  | { type: 'history'; versionId: string; versionName: string; design: Design };

export interface Session {
  page: 'plan' | '3d';
  mode: 'preview' | 'edit';
  dimension: 'room' | 'furniture';
  selection: Selection;
  overlay: Overlay;
  view3d: {
    scope: 'house' | { roomId: string };
    cutaway: boolean;
    /** 相机指令（AI 视图操作等外部触发）：n 变化时执行一次 top 俯视或 reset 默认视角 */
    camCmd: { kind: 'top' | 'reset'; n: number };
  };
}

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

export interface State {
  design: Design;
  past: Design[];
  future: Design[];
  session: Session;
  save: { status: SaveStatus; error?: string; savedAt?: string };
  lastCommit?: { mergeKey: string; at: number };
}

/** 程序给出的确定结果（方案第 17 节第 1 条：应用、放弃、过期由程序显示，不调用模型） */
export interface Outcome { ok: boolean; message: string; errors?: Issue[]; result?: ApplyResult }

export type Action = 'edit' | 'startTrial' | 'openHistory' | 'importExport' | 'saveVersion' | 'undo' | 'chat' | 'chatPropose';

export interface Deps {
  engine?: EngineOptions;
  /** 自动保存历史版本（VER-02）；返回 false 表示用户在保存失败后选择取消 */
  autoVersion?: (design: Design, reason: string) => Promise<boolean> | boolean;
  clock?: () => number;
}

const NOT_EDIT: Outcome = { ok: false, message: '当前是预览模式，请先切换到编辑模式' };

/** 第 8.2 节表格：每种叠加状态下哪些操作可用 */
export function can(s: Pick<State, 'session'>, action: Action): { ok: boolean; reason?: string } {
  const o = s.session.overlay.type;
  const no = (reason: string) => ({ ok: false, reason });
  switch (action) {
    case 'edit':
      if (o === 'history') return no('正在查看历史版本，不能修改；请先恢复此版本或退出查看');
      return { ok: true };
    case 'startTrial':
      if (o === 'trial') return no('已有一个试看方案，请先应用或放弃');
      if (o === 'history') return no('正在查看历史版本，请先退出查看');
      return { ok: true };
    case 'openHistory':
      if (o === 'trial') return no('请先应用或放弃当前试看');
      return { ok: true };
    case 'importExport':
    case 'saveVersion':
      if (o === 'trial') return no('试看中不能进行此操作，请先应用或放弃');
      if (o === 'history') return no('查看历史版本时不能进行此操作，请先退出查看');
      return { ok: true };
    case 'undo':
      if (o === 'history') return no('查看历史版本时不能撤销，请先退出查看');
      return { ok: true };
    case 'chat':
      return { ok: true };
    case 'chatPropose':
      if (o === 'history') return no('正在查看历史版本，提出的修改需要先退出查看');
      if (o === 'trial') return { ok: true }; // 用于继续调整当前试看
      return { ok: true };
  }
}

/** 画面显示的设计：试看中为候选，历史查看中为历史版本，否则为当前设计（TRY-05） */
export function displayDesign(s: Pick<State, 'design' | 'session'>): Design {
  const o = s.session.overlay;
  return o.type === 'trial' ? o.candidate : o.type === 'history' ? o.design : s.design;
}

/**
 * 方案 10.4：用户发送后设计又变了（等待期间手动修改），模型基于旧快照给出的提议
 * 若撞上等待期间改过的同一对象/字段，则不生成试看。字段级判断与试看过期同口径。
 * 提议在当前设计上本身就检查不过时返回 false——由 startTrial 的常规报错路径兜底。
 */
export function proposeConflicts(base: Design, current: Design, ops: unknown, engine?: EngineOptions): boolean {
  const r = applyOps(current, ops, engine);
  if (!r.ok) return false;
  return conflicts(changeKeys(r.changes), diffDesigns(base, current));
}

const changeKeys = (changes: Change[]) =>
  changes.map((c) => `${c.target.kind}:${c.target.id}:${c.action === 'update' ? c.field : '*'}`);

function conflicts(touched: string[], manual: Change[]): boolean {
  const t = new Set(touched);
  const tObjects = new Set(touched.map((k) => k.slice(0, k.lastIndexOf(':'))));
  return changeKeys(manual).some((k) => {
    const obj = k.slice(0, k.lastIndexOf(':'));
    return t.has(k) || (k.endsWith(':*') && tObjects.has(obj)) || t.has(`${obj}:*`);
  });
}

function objectExists(d: Design, sel: Selection): boolean {
  if (!sel) return true;
  switch (sel.kind) {
    case 'room': return d.rooms.some((r) => r.id === sel.id);
    case 'opening': return d.openings.some((o) => o.id === sel.id);
    case 'furniture': return d.furniture.some((f) => f.id === sel.id);
    case 'wall': return true; // 墙由界面在推导结果中核对
  }
}

export function createDesignStore(initial: Design, deps: Deps = {}) {
  const clock = deps.clock ?? (() => Date.now());

  const store = createStore<State>()(() => ({
    design: initial,
    past: [],
    future: [],
    session: {
      page: 'plan', mode: 'preview', dimension: 'room', selection: null,
      overlay: { type: 'none' }, view3d: { scope: 'house', cutaway: false, camCmd: { kind: 'reset', n: 0 } },
    },
    save: { status: 'saved' },
  }));
  const get = store.getState;
  const set = store.setState;

  /** 当前设计变了之后：清理失效选中；试看中则重放（方案 8.3 节第 1–3 步） */
  function afterDesignChange() {
    const s = get();
    if (!objectExists(s.design, s.session.selection)) set({ session: { ...s.session, selection: null } });
    const o = get().session.overlay;
    if (o.type !== 'trial') return;
    const manual = diffDesigns(o.base, s.design);
    if (conflicts(o.touched, manual)) {
      setOverlay({ ...o, stale: true, staleReason: `${describeTargets(manual, o.touched)}在试看期间被手动修改过，请重新生成` });
      return;
    }
    const r = applyOps(s.design, o.ops, deps.engine);
    if (!r.ok) {
      setOverlay({ ...o, stale: true, staleReason: `当前设计已变化，试看方案不再成立：${r.errors[0]!.message}` });
      return;
    }
    setOverlay({ ...o, candidate: r.next!, changes: r.changes, stale: false, staleReason: undefined });
  }

  function describeTargets(manual: Change[], touched: string[]): string {
    const objs = new Set(touched.map((k) => k.slice(0, k.lastIndexOf(':'))));
    const hit = manual.find((c) => objs.has(`${c.target.kind}:${c.target.id}`));
    return hit ? hit.text.split(/[：，]/)[0]!.replace(/^(新增|删除)/, '') : '相关对象';
  }

  function setOverlay(overlay: Overlay) { set({ session: { ...get().session, overlay } }); }

  function pushUndo(prev: Design, mergeKey?: string) {
    const s = get();
    const now = clock();
    const merge = mergeKey && s.lastCommit?.mergeKey === mergeKey && now - s.lastCommit.at <= NUDGE_MERGE_MS;
    set({
      past: merge ? s.past : [...s.past, prev].slice(-UNDO_LIMIT),
      future: [],
      lastCommit: mergeKey ? { mergeKey, at: now } : undefined,
    });
  }

  function markUnsaved() { set({ save: { ...get().save, status: 'unsaved', error: undefined } }); }

  const actions = {
    /** 手动修改：参数提交、拖动松手、方向键微调（mergeKey 相同且 0.5 秒内合并为一步撤销） */
    commit(ops: unknown, opts: { mergeKey?: string } = {}): Outcome {
      const s = get();
      if (s.session.mode !== 'edit') return NOT_EDIT;
      const allowed = can(s, 'edit');
      if (!allowed.ok) return { ok: false, message: allowed.reason! };
      const r = applyOps(s.design, ops, deps.engine);
      if (!r.ok) return { ok: false, message: r.errors[0]!.message, errors: r.errors, result: r };
      if (r.next !== s.design) {
        pushUndo(s.design, opts.mergeKey);
        set({ design: r.next! });
        markUnsaved();
        afterDesignChange();
      }
      return { ok: true, message: r.changes.length ? `已修改 ${r.changes.length} 项` : '没有变化', result: r };
    },

    /** 只检查不提交：拖动中的实时检查 */
    check(ops: unknown): ApplyResult { return applyOps(get().design, ops, deps.engine); },

    /** 风险操作前先存自动版本（VER-02 的删除房间等入口）：检查通过才备份，用户取消则不执行 */
    async commitWithBackup(ops: unknown, reason: string, opts: { mergeKey?: string } = {}): Promise<Outcome> {
      const s = get();
      if (s.session.mode !== 'edit') return NOT_EDIT;
      const allowed = can(s, 'edit');
      if (!allowed.ok) return { ok: false, message: allowed.reason! };
      const r = applyOps(s.design, ops, deps.engine);
      if (!r.ok) return { ok: false, message: r.errors[0]!.message, errors: r.errors, result: r };
      if (deps.autoVersion && !(await deps.autoVersion(s.design, reason))) return { ok: false, message: '已取消，设计未改变' };
      return actions.commit(ops, opts);
    },

    undo(): boolean {
      const s = get();
      if (!can(s, 'undo').ok || !s.past.length) return false;
      set({ design: s.past.at(-1)!, past: s.past.slice(0, -1), future: [s.design, ...s.future], lastCommit: undefined });
      markUnsaved();
      afterDesignChange();
      return true;
    },
    redo(): boolean {
      const s = get();
      if (!can(s, 'undo').ok || !s.future.length) return false;
      set({ design: s.future[0]!, future: s.future.slice(1), past: [...s.past, s.design].slice(-UNDO_LIMIT), lastCommit: undefined });
      markUnsaved();
      afterDesignChange();
      return true;
    },

    /** 整份替换：导入、恢复历史版本。完整检查，记一步撤销 */
    async replaceDesign(next: Design, reason: string): Promise<Outcome> {
      const s = get();
      const allowedKey: Action = s.session.overlay.type === 'history' ? 'openHistory' : 'importExport';
      if (!can(s, allowedKey).ok) return { ok: false, message: can(s, allowedKey).reason! };
      const parsed = DesignSchema.safeParse(next);
      if (!parsed.success) return { ok: false, message: '设计数据格式不正确，无法替换' };
      const errors = validateDesign(parsed.data).filter((i) => i.level === 'error');
      if (errors.length) return { ok: false, message: `设计中有 ${errors.length} 处问题：${errors[0]!.message}`, errors };
      if (deps.autoVersion && !(await deps.autoVersion(s.design, reason))) return { ok: false, message: '已取消' };
      const design = { ...parsed.data, revision: s.design.revision + 1 };
      pushUndo(s.design);
      set({ design, session: { ...get().session, overlay: { type: 'none' }, selection: null } });
      markUnsaved();
      return { ok: true, message: '已替换当前设计，可以撤销' };
    },

    // ---------- 试看（方案 8.3 节） ----------
    startTrial(source: 'ai' | 'style', ops: Op[], summary = ''): Outcome {
      const s = get();
      const allowed = can(s, 'startTrial');
      if (!allowed.ok) return { ok: false, message: allowed.reason! };
      const r = applyOps(s.design, ops, deps.engine);
      if (!r.ok) return { ok: false, message: r.errors[0]!.message, errors: r.errors, result: r };
      if (!r.changes.length) return { ok: false, message: '这些修改不会让设计产生任何变化', result: r };
      setOverlay({
        type: 'trial', source, summary, base: s.design, baseRevision: s.design.revision, ops,
        candidate: r.next!, changes: r.changes, touched: changeKeys(r.changes), stale: false,
      });
      return { ok: true, message: `试看中：${r.changes.length} 项修改，尚未应用`, result: r };
    },

    /** AI 继续调整：用新指令替换当前试看 */
    reviseTrial(ops: Op[], summary = ''): Outcome {
      const o = get().session.overlay;
      if (o.type !== 'trial') return { ok: false, message: '当前没有试看方案' };
      const r = applyOps(get().design, ops, deps.engine);
      if (!r.ok) return { ok: false, message: r.errors[0]!.message, errors: r.errors, result: r };
      setOverlay({ ...o, base: get().design, baseRevision: get().design.revision, ops, summary, candidate: r.next!, changes: r.changes, touched: changeKeys(r.changes), stale: false, staleReason: undefined });
      return { ok: true, message: `试看已更新：${r.changes.length} 项修改，尚未应用`, result: r };
    },

    async applyTrial(): Promise<Outcome> {
      const s = get();
      const o = s.session.overlay;
      if (o.type !== 'trial') return { ok: false, message: '当前没有试看方案' };
      if (o.stale) return { ok: false, message: `试看已过期，未应用：${o.staleReason ?? ''}` };
      const reason = o.source === 'ai' ? '应用 AI 修改前' : '应用风格前';
      if (deps.autoVersion && !(await deps.autoVersion(s.design, reason))) return { ok: false, message: '已取消应用，设计未改变' };
      const cur = get();
      const switched = cur.session.mode === 'preview';
      pushUndo(cur.design);
      set({ design: o.candidate, session: { ...cur.session, mode: 'edit', overlay: { type: 'none' } } });
      markUnsaved();
      afterDesignChange();
      return { ok: true, message: `已应用 ${o.changes.length} 项修改${switched ? '，已切换到编辑模式' : ''}，可以撤销` };
    },

    discardTrial(): Outcome {
      if (get().session.overlay.type !== 'trial') return { ok: false, message: '当前没有试看方案' };
      setOverlay({ type: 'none' });
      return { ok: true, message: '已放弃本次修改，设计未改变' };
    },

    // ---------- 历史查看 ----------
    openHistory(versionId: string, versionName: string, design: Design): Outcome {
      const allowed = can(get(), 'openHistory');
      if (!allowed.ok) return { ok: false, message: allowed.reason! };
      setOverlay({ type: 'history', versionId, versionName, design });
      return { ok: true, message: `正在查看历史版本「${versionName}」` };
    },
    exitHistory() { if (get().session.overlay.type === 'history') setOverlay({ type: 'none' }); },
    async restoreHistory(): Promise<Outcome> {
      const o = get().session.overlay;
      if (o.type !== 'history') return { ok: false, message: '当前没有在查看历史版本' };
      const wasPreview = get().session.mode === 'preview';
      const r = await actions.replaceDesign(o.design, '恢复版本前');
      // VER-05：预览模式恢复与 TRY-07 一样，先切到编辑模式
      if (r.ok && wasPreview) {
        set({ session: { ...get().session, mode: 'edit' } });
        return { ...r, message: `${r.message}，已切换到编辑模式` };
      }
      return r;
    },

    // ---------- 界面状态 ----------
    setPage(page: Session['page']) { set({ session: { ...get().session, page } }); },
    setMode(mode: Session['mode']) { set({ session: { ...get().session, mode } }); },
    setDimension(dimension: Session['dimension']) { set({ session: { ...get().session, dimension, selection: null } }); },
    select(selection: Selection) { set({ session: { ...get().session, selection } }); },
    setView3d(view3d: Partial<Session['view3d']>) { set({ session: { ...get().session, view3d: { ...get().session.view3d, ...view3d } } }); },
    setSave(save: State['save']) { set({ save }); },
  };

  return Object.assign(store, { actions });
}

export type DesignStore = ReturnType<typeof createDesignStore>;
export type { ObjectRef };
