// 3D 页（方案 12 节）：把 describeScene 的场景描述渲染出来。
// 交互：轨道相机（俯仰 10°–85°、轻微惯性）、剖面（朝镜头的墙降到 1000 mm，只在朝向变化时重建）、
// 单间视图（小展台、默认剖面、上一间/下一间）、点选（与平面页共享选中）、试看“修改前/修改后”。
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Design } from '../model/schema';
import { deriveWalls } from '../geometry/walls';
import { describeScene, type ScenePart, type SceneSpec } from './describe';
import { acquireBox, releaseBox, makeMaterial, kelvinToColor } from './materials';
import { actions, getStore, useApp } from '../ui/useApp';
import { register3DSnapshot } from '../ui/preview';
import { displayDesign } from '../store/designStore';

const EL_MIN = 10, EL_MAX = 85;      // 俯仰角范围（度，方案 12.4）
const CUT_HEIGHT = 1000;             // 剖面墙高（mm，方案 12.3）

interface Three { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; hemi: THREE.HemisphereLight; dir: THREE.DirectionalLight; group: THREE.Group; ray: THREE.Raycaster }

/** 朝向镜头一侧的墙段（方案 12.3）：h 墙看相机 z 与墙线的关系，v 墙看 x */
function facingWallKeys(design: Design, cam: THREE.Vector3): Set<string> {
  const keys = new Set<string>();
  for (const s of deriveWalls(design).segments) {
    if (s.open) continue;
    const camAlong = s.orientation === 'h' ? cam.z : cam.x;
    if (camAlong > s.line) keys.add(s.key);
  }
  return keys;
}

const btn = (active = false): React.CSSProperties => ({
  padding: '4px 10px', fontSize: 12, borderRadius: 8, border: '1px solid #D8D2C4', cursor: 'pointer',
  background: active ? '#E7DFC9' : '#FBF8F1', color: '#5A5245', whiteSpace: 'nowrap',
});

export function Scene3D({ onWallPick }: { onWallPick: (key: string | null) => void }) {
  const design = useApp(displayDesign);
  const session = useApp((s) => s.session);
  const overlay = session.overlay;
  const [trialView, setTrialView] = useState<'after' | 'before'>('after');
  const [glError, setGlError] = useState<string | null>(null);
  const [cutKeys, setCutKeys] = useState<ReadonlySet<string>>(new Set());
  const [frameSignal, setFrameSignal] = useState(0);
  const [topSignal, setTopSignal] = useState(0);

  // 试看“修改前”显示当前设计，“修改后”显示候选（displayDesign 已是候选）
  const before = getStore().getState().design;
  const shown: Design = overlay.type === 'trial' && trialView === 'before' ? before : design;

  // 单间指向的房间可能已删除：回退全屋
  const rawScope = session.view3d.scope;
  const scopeRoom = rawScope === 'house' ? null : design.rooms.find((r) => r.id === rawScope.roomId) ?? null;
  const scope: 'house' | { roomId: string } = scopeRoom ? { roomId: scopeRoom.id } : 'house';
  const singleRoom = scope !== 'house';
  const cutaway = singleRoom || session.view3d.cutaway;   // 单间默认剖面（方案 12.2）

  const scopeKey = singleRoom ? `room:${(scope as { roomId: string }).roomId}` : 'house';
  const cutKey = [...cutKeys].sort().join('|');
  const spec = useMemo<SceneSpec>(() => describeScene(shown, {
    scope,
    cutWallKeys: cutaway ? new Set(cutKey ? cutKey.split('|') : []) : undefined,
    cutHeight: CUT_HEIGHT,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [shown, scopeKey, cutaway, cutKey]);

  // 高亮：选中对象（与平面共享）+ 试看“修改后”里改动过的对象（方案 12.6）
  const sel = session.selection;
  const changedIds = overlay.type === 'trial' && trialView === 'after'
    ? new Set(overlay.changes.map((c) => `${c.target.kind}:${c.target.id}`)) : null;
  const highlightKey = `${sel ? `${sel.kind}:${sel.id}` : ''}|${changedIds ? [...changedIds].join(',') : ''}`;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const tRef = useRef<Three | null>(null);
  const camSigRef = useRef('');
  const camTimerRef = useRef(0);
  const lastExtentRef = useRef<number | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);

  // ---------- 初始化 ----------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let t: Three;
    try {
      const canvas = document.createElement('canvas');
      if (!canvas.getContext('webgl2')) throw new Error('此浏览器不支持 WebGL2');
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.setClearColor(0xf4f1e9);
      el.appendChild(renderer.domElement);
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.touchAction = 'none';

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 400);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = 0.08;      // 轻微惯性
      controls.minPolarAngle = ((90 - EL_MAX) * Math.PI) / 180;
      controls.maxPolarAngle = ((90 - EL_MIN) * Math.PI) / 180;
      controls.enablePan = true;
      controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

      const hemi = new THREE.HemisphereLight(0xffffff, 0xd8cfc0, 0.55);
      scene.add(hemi);
      const dir = new THREE.DirectionalLight(0xffffff, 2.1);
      dir.castShadow = true;
      dir.shadow.mapSize.set(2048, 2048);
      dir.shadow.bias = -0.0005;
      scene.add(dir, dir.target);
      const group = new THREE.Group();
      scene.add(group);
      t = { renderer, scene, camera, controls, hemi, dir, group, ray: new THREE.Raycaster() };
      tRef.current = t;
      // 验收用调试句柄（与平面页 window.h 同思路）：只读渲染器等对象，不参与逻辑
      (window as unknown as Record<string, unknown>).__scene3d = t;

      const resize = () => {
        const w = el.clientWidth, h = el.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      let raf = 0;
      const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);

      // 剖面：朝镜头的墙变化时才重建（方案 12.3），节流 150 ms
      const onCam = () => {
        const now = performance.now();
        if (now - camTimerRef.current < 150) return;
        camTimerRef.current = now;
        const sig = `${camera.position.x.toFixed(1)},${camera.position.z.toFixed(1)}`;
        if (sig === camSigRef.current) return;
        camSigRef.current = sig;
        setCutKeys(facingWallKeys(shownRef.current, camera.position));
      };
      controls.addEventListener('change', onCam);

      // 截图入口（方案 9.3/9.4）：历史版本缩略图、项目包预览用。
      // 不开 preserveDrawingBuffer，所以每次先重画一帧，同一任务里立刻读画布。
      const unregisterSnapshot = register3DSnapshot(async (width: number): Promise<Blob | null> => {
        renderer.render(scene, camera);
        const src = renderer.domElement;
        const h = Math.round((src.height / src.width) * width);
        const c = document.createElement('canvas');
        c.width = width;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(src, 0, 0, width, h);
        return await new Promise<Blob | null>((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
      });

      return () => {
        unregisterSnapshot();
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.removeEventListener('change', onCam);
        controls.dispose();
        renderer.dispose();
        renderer.domElement.remove();
        tRef.current = null;
      };
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 相机回调里要用最新的设计，但不想重装控制器
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // ---------- 场景重建（设计/范围/剖切/高亮变化时） ----------
  useEffect(() => {
    const t = tRef.current;
    if (!t) return;
    for (const child of [...t.group.children]) {
      const m = child as THREE.Mesh;
      t.group.remove(m);
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) mat.dispose();
      const acq = m.userData.acq as { size: [number, number, number]; radius?: number } | undefined;
      if (acq) releaseBox(acq.size, acq.radius);
    }
    const isSel = (p: ScenePart) => sel !== null && p.ref !== undefined && p.ref.kind === sel.kind && p.ref.id === sel.id;
    const isChanged = (p: ScenePart) => changedIds !== null && p.ref !== undefined && changedIds.has(`${p.ref.kind}:${p.ref.id}`);

    for (const p of spec.parts) {
      const geo = acquireBox(p.size, p.radius);
      const mat = makeMaterial(p.material, p.color);
      let material: THREE.Material | THREE.Material[];
      if (p.colorB && p.faceAxis) {
        // 共用墙/外墙两侧不同色（WALL-03）：按面分配材质（BoxGeometry 六面各一组）
        const b = makeMaterial(p.material, p.colorB);
        const side = makeMaterial(p.material, p.color);
        material = p.faceAxis === 'z'
          ? [side, side, side, side, mat, b]     // +z 朝 plus 房间
          : [mat, b, side, side, side, side];    // +x 朝 plus 房间
      } else {
        material = mat;
      }
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(...p.pos);
      if (p.rotY !== undefined) mesh.rotation.y = (p.rotY * Math.PI) / 180;
      if (p.kind !== 'opening') { mesh.castShadow = true; mesh.receiveShadow = true; }
      else mesh.receiveShadow = true;
      mesh.userData = { ref: p.ref, acq: { size: p.size, radius: p.radius } };
      if (isSel(p) || isChanged(p)) {
        for (const m of Array.isArray(material) ? material : [material]) {
          const std = m as THREE.MeshStandardMaterial;
          if (std.emissive) { std.emissive = new THREE.Color(0xb07840); std.emissiveIntensity = isChanged(p) ? 0.28 : 0.18; }
        }
      }
      t.group.add(mesh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, highlightKey]);

  // ---------- 灯光随风格（方案 12.4） ----------
  useEffect(() => {
    const t = tRef.current;
    if (!t) return;
    const { colorTemp, intensity } = shown.style.lighting;
    const warm = kelvinToColor(colorTemp);
    t.hemi.color.copy(warm).lerp(new THREE.Color(0xffffff), 0.35);
    t.hemi.intensity = 0.5 * intensity;
    t.dir.color.copy(warm);
    t.dir.intensity = 2.0 * intensity;
  }, [shown]);

  // ---------- 自动取景（方案 12.4：首次、切换单间、外轮廓明显变化 >20%、恢复视角） ----------
  const frame = (top = false) => {
    const t = tRef.current;
    if (!t) return;
    const [cx, cz] = spec.center;
    const r = spec.extent * 1.5 + 2.5;
    let az = Math.PI / 4;
    if (top) az = Math.atan2(t.camera.position.x - cx, t.camera.position.z - cz);
    const el = ((top ? EL_MAX : 40) * Math.PI) / 180;
    t.camera.position.set(cx + r * Math.cos(el) * Math.sin(az), r * Math.sin(el) + 1, cz + r * Math.cos(el) * Math.cos(az));
    t.controls.target.set(cx, 0.9, cz);
    t.controls.update();
  };
  useEffect(() => {
    const last = lastExtentRef.current;
    if (last === null || Math.abs(spec.extent - last) / Math.max(last, 0.001) > 0.2) frame();
    lastExtentRef.current = spec.extent;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, spec.extent, frameSignal]);
  useEffect(() => { if (topSignal) frame(true); }, [topSignal]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 外部相机指令（AI 的 top_view / reset_view）：n 变化时执行一次
  useEffect(() => {
    if (session.view3d.camCmd.n > 0) frame(session.view3d.camCmd.kind === 'top');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.view3d.camCmd.n]);

  // ---------- 阴影相机随范围 ----------
  useEffect(() => {
    const t = tRef.current;
    if (!t) return;
    const [cx, cz] = spec.center;
    const e = spec.extent + 2;
    t.dir.position.set(cx + e * 0.7, e * 1.6 + 6, cz - e * 0.5);
    t.dir.target.position.set(cx, 0, cz);
    const sc = t.dir.shadow.camera;
    sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e;
    sc.near = 1; sc.far = e * 4 + 20;
    sc.updateProjectionMatrix();
  }, [spec.center, spec.extent]);

  // ---------- 点选（方案 12.5） ----------
  useEffect(() => {
    const t = tRef.current;
    const el = containerRef.current;
    if (!t || !el) return;
    const ray = t.ray;
    const onDown = (e: PointerEvent) => { downRef.current = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      const d = downRef.current;
      downRef.current = null;
      if (!d || Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 5) return;   // 拖动不算点选
      const rect = t.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, t.camera);
      const hits = ray.intersectObjects(t.group.children, false);
      for (const hit of hits) {
        const ref = hit.object.userData.ref as ScenePart['ref'];
        if (!ref) continue;
        // 房间维度只能点中地面/墙/门窗（方案 12.5）；家具维度只点家具（PAGE-04）
        if (session.dimension === 'furniture' && ref.kind !== 'furniture') continue;
        if (session.dimension === 'room' && ref.kind === 'furniture') continue;
        actions().select({ kind: ref.kind, id: ref.id });
        return;
      }
      actions().select(null);
      onWallPick(null);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => { el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); };
  }, [session.dimension, onWallPick]);

  // ---------- WebGL 不可用（VIEW-06） ----------
  if (glError) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#5A5245' }}>
        <div style={{ fontSize: 14 }}>3D 无法显示：{glError}</div>
        <div style={{ fontSize: 12.5, color: '#8A8172' }}>可以继续使用平面图，设计数据不受影响</div>
        <button onClick={() => actions().setPage('plan')} style={btn()}>切换到平面图</button>
      </div>
    );
  }

  const rooms = getStore().getState().design.rooms;
  const roomIdx = scopeRoom ? rooms.findIndex((r) => r.id === scopeRoom.id) : -1;

  return (
    <div style={{ flex: 1, position: 'relative', minHeight: 0 }} ref={containerRef}>
      {/* 工具栏 */}
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 5, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={scopeRoom ? scopeRoom.id : 'house'}
          onChange={(e) => actions().setView3d({ scope: e.target.value === 'house' ? 'house' : { roomId: e.target.value } })}
          style={{ ...btn(), appearance: 'auto', padding: '3px 6px' }}
          title="全屋或单间展示（VIEW-02）"
        >
          <option value="house">全屋</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        {singleRoom && (
          <>
            <button
              onClick={() => { const prev = rooms[(roomIdx - 1 + rooms.length) % rooms.length]!; actions().setView3d({ scope: { roomId: prev.id } }); }}
              style={btn()} title="上一间">‹ 上一间</button>
            <button
              onClick={() => { const next = rooms[(roomIdx + 1) % rooms.length]!; actions().setView3d({ scope: { roomId: next.id } }); }}
              style={btn()} title="下一间">下一间 ›</button>
            <button onClick={() => actions().setView3d({ scope: 'house' })} style={btn()} title="回到全屋">回到全屋</button>
          </>
        )}
        <button
          onClick={() => actions().setView3d({ cutaway: !session.view3d.cutaway })}
          disabled={singleRoom}
          title={singleRoom ? '单间视图默认使用剖面' : '把朝向镜头一侧的墙降低，方便看室内（VIEW-03）'}
          style={{ ...btn(singleRoom || session.view3d.cutaway), opacity: singleRoom ? 0.55 : 1 }}
        >剖面</button>
        <button onClick={() => setFrameSignal((v) => v + 1)} style={btn()} title="恢复默认视角（VIEW-01）">恢复视角</button>
        <button onClick={() => setTopSignal((v) => v + 1)} style={btn()} title="俯视（VIEW-01）">俯视</button>
      </div>

      {/* 试看前后切换（方案 12.6） */}
      {overlay.type === 'trial' && (
        <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 5, display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid #D8D2C4' }}>
          {(['before', 'after'] as const).map((v) => (
            <button key={v} onClick={() => setTrialView(v)} style={{ ...btn(trialView === v), borderRadius: 0, border: 'none' }}>
              {v === 'before' ? '修改前' : '修改后'}
            </button>
          ))}
        </div>
      )}

      {design.rooms.length === 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A8172', fontSize: 13, pointerEvents: 'none' }}>
          还没有房间：先在平面图里画几间房
        </div>
      )}
    </div>
  );
}
