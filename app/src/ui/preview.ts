// 画面截图（方案 9.3 缩略图、9.4 项目包预览图）：
// 3D 页开着时截 3D 画面；否则把平面图（SVG）转成 PNG。只截画布区域，不含设置面板（密钥不入图）。
type Snapshot3D = (width: number) => Promise<Blob | null>;

let snapshot3d: Snapshot3D | null = null;

/** Scene3D 挂载时注册截图函数，卸载时反注册；返回反注册函数 */
export function register3DSnapshot(fn: Snapshot3D): () => void {
  snapshot3d = fn;
  return () => { if (snapshot3d === fn) snapshot3d = null; };
}

/** 平面图 → PNG：把页面上的平面 SVG 串行化后按指定宽度重绘（文字用系统默认字体，仅示意用） */
export async function capturePlanPng(width: number): Promise<Blob | null> {
  const svg = document.querySelector('svg[data-plan-canvas]') as SVGSVGElement | null;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.round(rect.width)));
  clone.setAttribute('height', String(Math.round(rect.height)));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('平面图转图片失败'));
    img.src = url;
  });
  const h = img.naturalWidth ? Math.round((img.naturalHeight / img.naturalWidth) * width) : width;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#FAF8F3'; // 与平面画布底色一致，避免 PNG 出现透明
  ctx.fillRect(0, 0, width, h);
  ctx.drawImage(img, 0, 0, width, h);
  return await new Promise<Blob | null>((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
}

/** 取一张预览图：3D 可用先截 3D，失败或不可用则截平面图 */
export async function capturePreview(width: number): Promise<Blob | null> {
  if (snapshot3d) {
    try {
      const b = await snapshot3d(width);
      if (b) return b;
    } catch { /* 3D 截图失败时落回平面图 */ }
  }
  try { return await capturePlanPng(width); } catch { return null; }
}
