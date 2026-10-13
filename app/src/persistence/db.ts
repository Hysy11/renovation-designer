// 本地存储（方案 9.1 节）：浏览器 IndexedDB 中的 renovation-designer 数据库。
// API Key 不进这个数据库（方案 9.7 节）。
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Design } from '../model/schema';

export const DB_NAME = 'renovation-designer';

export interface VersionRecord {
  id: string;
  name: string;
  createdAt: string;
  kind: 'manual' | 'auto' | 'backup';
  reason?: string;
  design: unknown; // 读出时须经过迁移与检查
}

interface Schema extends DBSchema {
  current: { key: 'current'; value: { design: Design; savedAt: string } };
  versions: { key: string; value: VersionRecord; indexes: { byTime: string } };
  thumbs: { key: string; value: Blob };
  prefs: { key: string; value: unknown };
}

export type DB = IDBPDatabase<Schema>;

export function openDesignDB(): Promise<DB> {
  return openDB<Schema>(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore('current');
      db.createObjectStore('versions', { keyPath: 'id' }).createIndex('byTime', 'createdAt');
      db.createObjectStore('thumbs');
      db.createObjectStore('prefs');
    },
  });
}

export async function saveCurrent(db: DB, design: Design, savedAt: string) {
  await db.put('current', { design, savedAt }, 'current');
}

export async function loadCurrentRaw(db: DB): Promise<{ design: unknown; savedAt: string } | undefined> {
  return db.get('current', 'current');
}

export async function putVersion(db: DB, v: VersionRecord) {
  await db.put('versions', v);
}

/** 全部版本，新→旧（VER-03 列表按时间排列） */
export async function listVersionRecords(db: DB): Promise<VersionRecord[]> {
  const all = await db.getAll('versions');
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
}

export async function getVersionRecord(db: DB, id: string): Promise<VersionRecord | undefined> {
  return db.get('versions', id);
}

export async function deleteVersionRecord(db: DB, id: string) {
  await db.delete('versions', id);
  await db.delete('thumbs', id);
}

export async function putThumb(db: DB, versionId: string, blob: Blob) {
  await db.put('thumbs', blob, versionId);
}

export async function getThumb(db: DB, versionId: string): Promise<Blob | undefined> {
  return db.get('thumbs', versionId);
}

export async function getPref<T>(db: DB, key: string): Promise<T | undefined> {
  return (await db.get('prefs', key)) as T | undefined;
}
export async function setPref(db: DB, key: string, value: unknown) {
  await db.put('prefs', value, key);
}
