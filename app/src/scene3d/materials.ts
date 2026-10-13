// 3D 材质与纹理（方案 6.6：材质用画布实时生成，固定随机种子，换电脑效果一致）。
// 纹理按颜色缓存；几何与材质带引用计数，重建场景时释放不再使用的显存（方案 12.1）。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { MaterialId, FloorMaterialId } from '../model/schema';

// ---------- 固定种子伪随机（同一输入必然同一纹理） ----------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedOf = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

// ---------- 程序化纹理 ----------

const S = 256;
const texCache = new Map<string, THREE.Texture>();

function makeCanvas(key: string, draw: (ctx: CanvasRenderingContext2D, rnd: () => number) => void): THREE.Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  draw(canvas.getContext('2d')!, mulberry32(seedOf(key)));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, tex);
  return tex;
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

/** 木纹：底色 + 深浅条纹 + 细噪声 */
function woodTexture(color: string): THREE.Texture {
  return makeCanvas(`wood:${color}`, (ctx, rnd) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      const y = rnd() * S;
      ctx.strokeStyle = shade(color, 0.82 + rnd() * 0.3);
      ctx.lineWidth = 1 + rnd() * 3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, y + Math.sin((x + i * 40) * 0.05) * 3);
      ctx.stroke();
    }
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.05})`;
      ctx.fillRect(rnd() * S, rnd() * S, 2, 1);
    }
  });
}

/** 布纹：底色 + 编织细线 */
function fabricTexture(color: string): THREE.Texture {
  return makeCanvas(`fabric:${color}`, (ctx, rnd) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = shade(color, 0.92);
    ctx.lineWidth = 1;
    for (let x = 0; x < S; x += 4) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S); ctx.stroke(); }
    ctx.strokeStyle = shade(color, 1.06);
    for (let y = 0; y < S; y += 4) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.04})`;
      ctx.fillRect(rnd() * S, rnd() * S, 2, 2);
    }
  });
}

/** 瓷砖：浅色底 + 网格缝 */
function tileTexture(color: string): THREE.Texture {
  return makeCanvas(`tile:${color}`, (ctx) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = shade(color, 0.8);
    ctx.lineWidth = 3;
    for (let i = 0; i <= S; i += S / 2) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke();
    }
  });
}

/** 水泥：底色 + 大颗粒噪声 */
function concreteTexture(color: string): THREE.Texture {
  return makeCanvas(`concrete:${color}`, (ctx, rnd) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 2500; i++) {
      ctx.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${rnd() * 0.08})` : `rgba(0,0,0,${rnd() * 0.06})`;
      ctx.fillRect(rnd() * S, rnd() * S, 2, 2);
    }
  });
}

/** 地毯：布纹加密 */
function carpetTexture(color: string): THREE.Texture {
  return makeCanvas(`carpet:${color}`, (ctx, rnd) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${rnd() * 0.1})` : `rgba(0,0,0,${rnd() * 0.08})`;
      ctx.fillRect(rnd() * S, rnd() * S, 1.5, 1.5);
    }
  });
}

// ---------- 材质工厂（引用计数） ----------

export function makeMaterial(id: MaterialId | FloorMaterialId, color: string): THREE.Material {
  switch (id) {
    case 'wood':
      return new THREE.MeshStandardMaterial({ color: 0xffffff, map: woodTexture(color), roughness: 0.62, metalness: 0 });
    case 'fabric':
      return new THREE.MeshStandardMaterial({ color: 0xffffff, map: fabricTexture(color), roughness: 0.95, metalness: 0 });
    case 'metal':
      return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.32, metalness: 0.85 });
    case 'glass':
      return new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(color), transparent: true, opacity: 0.45,
        roughness: 0.08, metalness: 0, transmission: 0.6, thickness: 0.02,
      });
    case 'wood-floor':
      return new THREE.MeshStandardMaterial({ color: 0xffffff, map: woodTexture(color), roughness: 0.55, metalness: 0 });
    case 'tile':
      return new THREE.MeshStandardMaterial({ color: 0xffffff, map: tileTexture(color), roughness: 0.35, metalness: 0.05 });
    case 'concrete':
      return new THREE.MeshStandardMaterial({ color: 0xffffff, map: concreteTexture(color), roughness: 0.9, metalness: 0 });
    case 'carpet':
      return new THREE.MeshStandardMaterial({ color: 0xffffff, map: carpetTexture(color), roughness: 1, metalness: 0 });
    default: // matte
      return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.88, metalness: 0 });
  }
}

// ---------- 几何缓存（引用计数） ----------

interface GeoEntry { geo: THREE.BufferGeometry; count: number }
const geoCache = new Map<string, GeoEntry>();

export function acquireBox(size: [number, number, number], radius?: number): THREE.BufferGeometry {
  const r = Math.min(radius ?? 0, ...size.map((s) => s / 2));
  const key = `${size.join(',')}@${r.toFixed(4)}`;
  let e = geoCache.get(key);
  if (!e) {
    e = { geo: r > 0.001 ? new RoundedBoxGeometry(size[0], size[1], size[2], 2, r) : new THREE.BoxGeometry(...size), count: 0 };
    geoCache.set(key, e);
  }
  e.count++;
  return e.geo;
}

export function releaseBox(size: [number, number, number], radius?: number): void {
  const r = Math.min(radius ?? 0, ...size.map((s) => s / 2));
  const key = `${size.join(',')}@${r.toFixed(4)}`;
  const e = geoCache.get(key);
  if (e && --e.count <= 0) { e.geo.dispose(); geoCache.delete(key); }
}

/** 清空全部缓存（测试用） */
export function clearCaches(): void {
  for (const e of geoCache.values()) e.geo.dispose();
  geoCache.clear();
  for (const t of texCache.values()) t.dispose();
  texCache.clear();
}

// ---------- 色温换算（方案 12.4：灯光颜色由风格色温换算） ----------

/** 开尔文 → RGB（Kim 1989 近似，足够灯光用） */
export function kelvinToColor(kelvin: number): THREE.Color {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.52 * Math.log(t - 10) - 305.04;
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return new THREE.Color(c(r), c(g), c(b));
}
