// 项目包（方案 9.4、9.5 节）：zip 容器，内含 manifest.json、design.json、preview.png。
// 家具和材质是程序内置的，只记编号与版本，不重复打包（SAVE-03）；
// 导出内容只有当前设计，不含密钥、历史版本、撤销记录、聊天记录（SAVE-07）。
import JSZip from 'jszip';
import type { Design } from '../model/schema';
import { migrateAndCheck } from '../engine/load';
import { getTemplate } from '../catalog/furniture';
import { APP_VERSION } from '../version';

export const PKG_FORMAT_ID = 'renovation-designer-project';
export const PKG_FORMAT_VERSION = 1;

export interface Manifest {
  format: string;                                    // 文件格式标识
  formatVersion: number;                             // 项目包格式版本
  schemaVersion: number;                             // 设计数据格式版本
  appVersion: string;                                // 导出时的程序版本
  exportedAt: string;                                // 导出时间
  templates: { id: string; version: number }[];      // 用到的家具模板编号与版本
  materials: string[];                               // 用到的材质编号
}

/** 设计里实际用到的家具模板（编号与当前程序中的版本）和材质编号 */
export function usedCatalog(design: Design): Pick<Manifest, 'templates' | 'materials'> {
  const templates = new Map<string, number>();
  for (const f of design.furniture) {
    const tpl = getTemplate(f.templateId);
    templates.set(f.templateId, Math.max(templates.get(f.templateId) ?? 0, tpl?.version ?? 1));
  }
  const materials = new Set<string>();
  for (const r of design.rooms) if (r.floor?.material) materials.add(r.floor.material);
  for (const f of design.furniture) for (const p of Object.values(f.appearance ?? {})) if (p.material) materials.add(p.material);
  materials.add(design.style.floor.material);
  materials.add(design.display.base.material);
  return {
    templates: [...templates].map(([id, version]) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)),
    materials: [...materials].sort(),
  };
}

/** 导出文件名：`设计名-YYYYMMDD-HHMM.rdproj.zip`（方案 9.4），设计名里的非法字符换掉 */
export function packageFileName(name: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const safe = Array.from(name.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-')).slice(0, 40).join('') || '未命名设计';
  return `${safe}-${stamp}.rdproj.zip`;
}

/** 打包当前设计；previewPng 为空（截图不可用）时省略 preview.png，其余照常 */
export async function exportProjectPackage(
  design: Design,
  previewPng: Blob | null,
  now: () => Date = () => new Date(),
): Promise<Blob> {
  const at = now();
  const manifest: Manifest = {
    format: PKG_FORMAT_ID,
    formatVersion: PKG_FORMAT_VERSION,
    schemaVersion: design.schemaVersion,
    appVersion: APP_VERSION,
    exportedAt: at.toISOString(),
    ...usedCatalog(design),
  };
  const zip = new JSZip();
  zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file('design.json', `${JSON.stringify(design, null, 2)}\n`);
  if (previewPng) zip.file('preview.png', previewPng);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export interface ImportSummary {
  name: string;
  rooms: number;
  furniture: number;
  openings: number;
  exportedAt?: string;
}

export type ImportCheck =
  | { ok: true; design: Design; summary: ImportSummary; preview: Blob | null }
  | { ok: false; reason: string; details?: string[] };

/**
 * 读取项目包并做导入前的全部检查（方案 9.5 节）：
 * 格式标识 → 格式版本 → 设计迁移与完整检查 → 家具模板齐全性；都通过才返回摘要让界面确认。
 */
export async function inspectProjectPackage(file: Blob): Promise<ImportCheck> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(file); } catch { return { ok: false, reason: '文件打不开：不是有效的 zip 项目包' }; }

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) return { ok: false, reason: '包里缺少 manifest.json，不是本程序的项目包' };
  let manifest: Manifest;
  try { manifest = JSON.parse(await manifestFile.async('string')) as Manifest; } catch { return { ok: false, reason: 'manifest.json 读不出来' }; }
  if (manifest?.format !== PKG_FORMAT_ID) return { ok: false, reason: '这不是本程序导出的项目包' };
  if (manifest.formatVersion > PKG_FORMAT_VERSION)
    return { ok: false, reason: `项目包格式版本（v${manifest.formatVersion}）比本程序支持的（v${PKG_FORMAT_VERSION}）更新，请先更新程序` };

  const designFile = zip.file('design.json');
  if (!designFile) return { ok: false, reason: '包里缺少 design.json' };
  let raw: unknown;
  try { raw = JSON.parse(await designFile.async('string')); } catch { return { ok: false, reason: 'design.json 读不出来' }; }

  // 第 2、3 步：版本迁移（更新则拒绝，更旧则升级）+ 与引擎相同的完整检查
  const r = migrateAndCheck(raw);
  if (!r.ok) return { ok: false, reason: r.reason, details: r.details };

  // 第 4 步：家具模板编号存在且本程序版本不低于文件记录的版本；缺失时列明，不替换成别的家具
  const recorded = new Map((manifest.templates ?? []).map((t) => [t.id, t.version]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of r.design.furniture) {
    if (seen.has(f.templateId)) continue;
    seen.add(f.templateId);
    const want = recorded.get(f.templateId) ?? 1;
    const tpl = getTemplate(f.templateId);
    if (!tpl) problems.push(`模板「${f.templateId}」本程序没有（家具「${f.name}」用到）`);
    else if (tpl.version < want) problems.push(`模板「${tpl.name}」（${tpl.id}）版本过旧：文件记录 v${want}，本程序 v${tpl.version}`);
  }
  if (problems.length)
    return { ok: false, reason: `有 ${problems.length} 项家具模板缺失或过旧，不能导入（不会替换成别的家具）`, details: problems.slice(0, 8) };

  const previewFile = zip.file('preview.png');
  let preview: Blob | null = null;
  if (previewFile) {
    try {
      // jszip 读出的 Blob 没有类型，标成 image/png 让 <img> 与对象地址都能正确识别
      preview = new Blob([await previewFile.async('arraybuffer')], { type: 'image/png' });
    } catch {
      return { ok: false, reason: '包里的 preview.png 读不出来（文件可能损坏）' };
    }
  }
  return {
    ok: true,
    design: r.design,
    preview,
    summary: {
      name: r.design.meta.name,
      rooms: r.design.rooms.length,
      furniture: r.design.furniture.length,
      openings: r.design.openings.length,
      exportedAt: manifest.exportedAt,
    },
  };
}
