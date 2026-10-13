// 数据库句柄单例：main.tsx 启动时注册，界面（导入导出、历史版本）从这里取。
// ai/ 与 store/ 不直接持有 db，保持依赖方向（方案 2.2）。
import type { DB } from '../persistence/db';

let db: DB | undefined;

export function setAppDB(instance: DB) { db = instance; }
export function appDB(): DB {
  if (!db) throw new Error('数据库尚未打开');
  return db;
}
