// 程序入口：打开本地数据库 → 读取上次的设计 → 建立状态 → 开始自动保存 → 显示界面
import { createRoot } from 'react-dom/client';
import { createDesignStore } from './store/designStore';
import { openDesignDB } from './persistence/db';
import { loadOrCreate, requestPersistence, startAutosave } from './persistence/autosave';
import { saveVersion } from './persistence/versions';
import { installStore } from './ui/useApp';
import { setAppDB } from './ui/dbAccess';
import { appConfirm } from './ui/appConfirm';
import { AppShell } from './ui/AppShell';

const root = createRoot(document.getElementById('root')!);

async function boot() {
  const db = await openDesignDB();
  setAppDB(db);
  const { design, notice } = await loadOrCreate(db);
  // VER-02 自动版本：风险操作（应用试看/删除房间/导入替换/恢复版本）前保存当前设计；
  // 保存失败时提示，由用户决定继续还是取消（返回 false 则该操作不执行）
  const store = createDesignStore(design, {
    autoVersion: async (current, reason) => {
      const r = await saveVersion(db, { design: current, kind: 'auto', reason });
      if (r.ok) return true;
      return appConfirm({
        title: '自动保存历史版本失败',
        lines: [r.message, '要继续当前操作吗？选择“取消”则本次操作不执行。'],
        confirmText: '继续操作',
      });
    },
  });
  installStore(store);
  const autosave = startAutosave(store, db);
  // 关闭或刷新页面前尽量写入最后一次修改
  window.addEventListener('pagehide', () => { void autosave.flushNow(); });
  const persisted = await requestPersistence();
  // 验收调试入口：本地工具用，不参与任何业务逻辑（与平面页运行时注入同思路）
  (window as unknown as Record<string, unknown>).__rd = { store };
  root.render(<AppShell notice={notice} persisted={persisted} />);
}

boot().catch((e: unknown) => {
  root.render(
    <div style={{ padding: 24, fontFamily: 'system-ui', color: '#8a2a2a' }}>
      程序启动失败：{e instanceof Error ? e.message : String(e)}
      <br />请确认没有使用无痕窗口，然后刷新页面重试。
    </div>,
  );
});
