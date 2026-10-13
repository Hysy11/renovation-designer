// 图片附件的压缩（方案 10.3 / 需求 AI-10）：
// 长边压到 1600 像素以内、重新编码为 JPEG；结果只在内存里（data URL），
// 不写 IndexedDB、不进导出包。单轮最多 3 张在界面层限制。
import type { ChatImage } from './types';

export const MAX_IMAGES_PER_TURN = 3;
export const MAX_EDGE = 1600;

/** 浏览器环境：用 canvas 压缩 */
async function compressInBrowser(file: File | Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close();
  }
}

/** 压缩一张用户选择的图片；环境不支持（如测试）时退回原始 data URL */
export async function compressImage(file: File | Blob): Promise<ChatImage> {
  const name = file instanceof File ? file.name : '图片';
  try {
    return { name, dataUrl: await compressInBrowser(file) };
  } catch {
    // 退路：直接读文件内容（仅当浏览器提供了 FileReader 时）
    if (typeof FileReader !== 'undefined') {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('图片读取失败'));
        fr.readAsDataURL(file);
      });
      return { name, dataUrl };
    }
    throw new Error('当前环境不支持处理图片');
  }
}
