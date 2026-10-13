// 全局唯一的设计状态与 React 读取入口。启动流程见 main.tsx。
import { useStore } from 'zustand';
import type { DesignStore, State } from '../store/designStore';

let store: DesignStore | undefined;

export function installStore(s: DesignStore) { store = s; }

export function getStore(): DesignStore {
  if (!store) throw new Error('状态尚未初始化');
  return store;
}

/** 在组件中读取状态的一部分；返回值变化时组件重绘 */
export function useApp<T>(pick: (s: State) => T): T {
  return useStore(getStore(), pick);
}

export const actions = () => getStore().actions;
