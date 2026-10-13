// 读取保存的设计时：判断格式版本、依次迁移、完整检查（方案 6.9、9.5 节）。纯逻辑。
import { Design, SCHEMA_VERSION } from '../model/schema';
import { validateDesign } from '../geometry/validate';

/** 第 n 版 → 第 n+1 版的转换函数；改变数据格式时在这里追加 */
const MIGRATIONS: Record<number, (d: Record<string, unknown>) => Record<string, unknown>> = {};

export type LoadResult = { ok: true; design: Design } | { ok: false; reason: string; details?: string[] };

export function migrateAndCheck(raw: unknown): LoadResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '不是有效的设计数据' };
  let data = raw as Record<string, unknown>;
  const v = data.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { ok: false, reason: '缺少数据格式版本' };
  if (v > SCHEMA_VERSION) return { ok: false, reason: `该设计由更新的程序保存（格式版本 ${v}），请先更新程序` };
  for (let n = v; n < SCHEMA_VERSION; n++) {
    const step = MIGRATIONS[n];
    if (!step) return { ok: false, reason: `无法从格式版本 ${n} 升级` };
    data = step(data);
  }
  const parsed = Design.safeParse(data);
  if (!parsed.success)
    return { ok: false, reason: '设计数据格式不正确', details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}：${i.message}`) };
  const errors = validateDesign(parsed.data).filter((i) => i.level === 'error');
  if (errors.length) return { ok: false, reason: `设计中有 ${errors.length} 处问题`, details: errors.slice(0, 5).map((e) => e.message) };
  return { ok: true, design: parsed.data };
}
