// 项目包导入导出（方案 9.4、9.5 节；验收 723 行“保存”类）：
// 导出再导入一致、manifest 内容、文件名、各类拒绝路径（非本程序包/格式更新/schema 更新/模板过旧/缺模板/坏数据）。
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  PKG_FORMAT_ID, PKG_FORMAT_VERSION,
  exportProjectPackage, inspectProjectPackage, packageFileName, usedCatalog,
} from '../src/persistence/projectPackage';
import { APP_VERSION } from '../src/version';
import { design, furn, room, twoRooms } from './fixtures';
import type { Design } from '../src/model/schema';

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const fakePng = () => new Blob([pngBytes], { type: 'image/png' });

/** 手工拼一个 zip（不走导出函数），用于构造各种“问题包” */
async function makeZip(files: Record<string, string | Blob>): Promise<Blob> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

const withBed = (): Design =>
  design({
    rooms: [room('r_a', 0, 0, 5000, 4000, '主卧')],
    // 床要离墙留出墙厚（120 mm），否则完整检查判“穿墙”
    furniture: [furn('f_bed', 'r_a', 'bed.double', 1200, 1300, 1800, 2000, { h: 450 })],
  });

describe('项目包：导出（SAVE-03/07）', () => {
  it('导出再导入后设计完全一致；manifest 记录程序版本、模板与材质；预览图原样带回', async () => {
    const d = withBed();
    const blob = await exportProjectPackage(d, fakePng(), () => new Date('2026-10-13T08:30:00Z'));

    // 包里的三个文件与 manifest 内容
    const zip = await JSZip.loadAsync(blob);
    expect(zip.file('manifest.json')).toBeTruthy();
    expect(zip.file('design.json')).toBeTruthy();
    expect(zip.file('preview.png')).toBeTruthy();
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.format).toBe(PKG_FORMAT_ID);
    expect(manifest.formatVersion).toBe(PKG_FORMAT_VERSION);
    expect(manifest.schemaVersion).toBe(d.schemaVersion);
    expect(manifest.appVersion).toBe(APP_VERSION);
    expect(manifest.exportedAt).toBe('2026-10-13T08:30:00.000Z');
    expect(manifest.templates).toEqual([{ id: 'bed.double', version: 1 }]);
    expect(manifest.materials.length).toBeGreaterThan(0);
    expect(JSON.parse(await zip.file('design.json')!.async('string'))).toEqual(d);

    // 再导入：设计一致、摘要正确、预览图字节一致且带 image/png 类型
    const c = await inspectProjectPackage(blob);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.design).toEqual(d);
      expect(c.summary).toEqual({ name: '测试', rooms: 1, furniture: 1, openings: 0, exportedAt: '2026-10-13T08:30:00.000Z' });
      expect(c.preview).toBeTruthy();
      expect(c.preview!.type).toBe('image/png');
      expect(new Uint8Array(await c.preview!.arrayBuffer())).toEqual(pngBytes);
    }
  });

  it('导出内容不含密钥、聊天记录、撤销记录（SAVE-07：设计对象本身就没有这些字段）', async () => {
    const blob = await exportProjectPackage(twoRooms(), null);
    const zip = await JSZip.loadAsync(blob);
    const names = Object.keys(zip.files);
    expect(names.sort()).toEqual(['design.json', 'manifest.json']);
    const text = await zip.file('design.json')!.async('string');
    expect(text).not.toMatch(/sk-|apiKey|api_key|messages|history/i);
  });

  it('文件名：设计名-日期-时间.rdproj.zip；非法字符清洗；空名兜底；超长按字符截断', () => {
    expect(packageFileName('我的家', new Date(2026, 9, 13, 15, 30))).toBe('我的家-20261013-1530.rdproj.zip');
    expect(packageFileName('a/b:c*d?e', new Date(2026, 9, 13, 15, 30))).toBe('abcde-20261013-1530.rdproj.zip');
    expect(packageFileName('   ')).toMatch(/^未命名设计-\d{8}-\d{4}\.rdproj\.zip$/);
    // 超长截断按字符进行，不把 emoji 的代理对切成一半
    expect(packageFileName('😀'.repeat(50), new Date(2026, 9, 13, 15, 30))).toBe(`${'😀'.repeat(40)}-20261013-1530.rdproj.zip`);
  });

  it('usedCatalog 汇总家具模板与材质，不重复', () => {
    const d = design({
      rooms: [room('r_a', 0, 0, 5000, 4000)],
      furniture: [
        furn('f1', 'r_a', 'bed.double', 1000, 1000, 1800, 2000),
        furn('f2', 'r_a', 'bed.double', 3000, 1000, 1800, 2000),
      ],
    });
    const cat = usedCatalog(d);
    expect(cat.templates).toEqual([{ id: 'bed.double', version: 1 }]);
    expect(new Set(cat.materials).size).toBe(cat.materials.length);
  });
});

describe('项目包：导入检查（SAVE-04）', () => {
  const manifestOf = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ format: PKG_FORMAT_ID, formatVersion: PKG_FORMAT_VERSION, schemaVersion: 1, appVersion: APP_VERSION, exportedAt: '2026-10-13T08:30:00.000Z', templates: [], materials: [], ...over });

  it('不是 zip / 缺 manifest / 格式标识不对 → 拒绝', async () => {
    expect(await inspectProjectPackage(new Blob(['这不是压缩包']))).toMatchObject({ ok: false, reason: expect.stringContaining('打不开') });
    expect(await inspectProjectPackage(await makeZip({ 'readme.txt': 'hi' }))).toMatchObject({ ok: false, reason: expect.stringContaining('manifest.json') });
    expect(await inspectProjectPackage(await makeZip({ 'manifest.json': JSON.stringify({ format: '别的程序' }) })))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不是本程序导出的项目包') });
  });

  it('项目包格式版本比本程序新 → 请先更新程序', async () => {
    const pkg = await makeZip({ 'manifest.json': manifestOf({ formatVersion: PKG_FORMAT_VERSION + 1 }), 'design.json': JSON.stringify(twoRooms()) });
    expect(await inspectProjectPackage(pkg)).toMatchObject({ ok: false, reason: expect.stringContaining('请先更新程序') });
  });

  it('schemaVersion 比本程序新 → 请先更新程序（走引擎的迁移检查）', async () => {
    const newer = { ...twoRooms(), schemaVersion: 99 };
    const pkg = await makeZip({ 'manifest.json': manifestOf(), 'design.json': JSON.stringify(newer) });
    expect(await inspectProjectPackage(pkg)).toMatchObject({ ok: false, reason: expect.stringContaining('请先更新程序') });
  });

  it('模板版本比文件记录的旧 → 列出并拒绝，不替换成别的家具', async () => {
    const pkg = await makeZip({
      'manifest.json': manifestOf({ templates: [{ id: 'bed.double', version: 2 }] }),
      'design.json': JSON.stringify(withBed()),
    });
    const r = await inspectProjectPackage(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('家具模板');
      expect(r.details?.[0]).toContain('双人床');
      expect(r.details?.[0]).toContain('v2');
    }
  });

  it('设计里的模板本程序没有 → 完整检查阶段就拒绝', async () => {
    const bad = design({
      rooms: [room('r_a', 0, 0, 5000, 4000)],
      furniture: [furn('f_x', 'r_a', 'no.such.template', 1000, 1000, 1000, 1000)],
    });
    const pkg = await makeZip({ 'manifest.json': manifestOf(), 'design.json': JSON.stringify(bad) });
    const r = await inspectProjectPackage(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('问题');
  });

  it('design.json 不是合法设计 → 拒绝并列出问题', async () => {
    const pkg = await makeZip({ 'manifest.json': manifestOf(), 'design.json': '{"乱写的":true}' });
    const r = await inspectProjectPackage(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBeTruthy();
  });

  it('没有预览图的包也能导入（preview 为空）', async () => {
    const pkg = await makeZip({ 'manifest.json': manifestOf(), 'design.json': JSON.stringify(twoRooms()) });
    const c = await inspectProjectPackage(pkg);
    expect(c.ok).toBe(true);
    if (c.ok) { expect(c.preview).toBeNull(); expect(c.summary.rooms).toBe(2); }
  });
});
