// 历史版本（方案 9.3 节、需求 VER-01～08）：
// 手动（可命名）、自动（风险操作前、注明原因、只留最近 20 个）、备份（读不出的数据兜底，不清不删）。
// 空间超过 90% 时拒绝保存并提示清理，不静默丢弃（VER-07）。缩略图与版本数据分开存（方案 9.1）。
import type { Design } from '../model/schema';
import type { VersionRecord } from './db';
import {
  deleteVersionRecord, getThumb, getVersionRecord, listVersionRecords, putThumb, putVersion, type DB,
} from './db';

export const AUTO_VERSION_LIMIT = 20;
export const SPACE_WARN_RATIO = 0.9;

export interface SaveVersionResult { ok: boolean; message: string; record?: VersionRecord }

export { listVersionRecords as listVersions, deleteVersionRecord as deleteVersion, getVersionRecord as getVersion, getThumb };

/** 未填名称时按时间命名（VER-01），如「2026-10-13 15:30」；用本地时间，与列表里的保存时间一致 */
function timeName(at: string): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function spaceTooFull(): Promise<boolean> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || !est.quota) return false;
    return (est.usage ?? 0) / est.quota > SPACE_WARN_RATIO;
  } catch { return false; }
}

/** 保存一个版本；kind=auto 时裁掉超出上限的最旧自动版本（手动与备份不动） */
export async function saveVersion(
  db: DB,
  input: { design: Design; kind: VersionRecord['kind']; name?: string; reason?: string },
  now: () => string = () => new Date().toISOString(),
): Promise<SaveVersionResult> {
  if (await spaceTooFull()) {
    return { ok: false, message: `本地存储空间已用超过 ${Math.round(SPACE_WARN_RATIO * 100)}%，请删除一些历史版本或导出备份后再试（不会静默丢弃）` };
  }
  const at = now();
  const base = `v_${Date.parse(at)}_${input.kind}`;
  let id = base;
  for (let n = 2; await getVersionRecord(db, id); n++) id = `${base}_${n}`; // 同一毫秒重名时加序号
  const record: VersionRecord = {
    id, createdAt: at, kind: input.kind,
    name: input.name?.trim() || timeName(at),
    ...(input.reason ? { reason: input.reason } : {}),
    design: input.design,
  };
  await putVersion(db, record);
  if (input.kind === 'auto') await trimAutoVersions(db);
  return { ok: true, message: `已保存版本「${record.name}」`, record };
}

/** 自动版本只保留最近 AUTO_VERSION_LIMIT 个（VER-07） */
export async function trimAutoVersions(db: DB): Promise<number> {
  const autos = (await listVersionRecords(db)).filter((v) => v.kind === 'auto');
  const removed = autos.slice(AUTO_VERSION_LIMIT);
  for (const v of removed) await deleteVersionRecord(db, v.id);
  return removed.length;
}

export async function renameVersion(db: DB, id: string, name: string): Promise<boolean> {
  const v = await getVersionRecord(db, id);
  if (!v || !name.trim()) return false;
  await putVersion(db, { ...v, name: name.trim() });
  return true;
}

export async function saveThumb(db: DB, versionId: string, blob: Blob) {
  await putThumb(db, versionId, blob);
}
