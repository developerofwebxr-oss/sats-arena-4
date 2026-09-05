import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import arenaGlbUrl from '../assets/sats-arena-imperial-gold-v1.glb?url';
// JPEG, not PNG: an equirect skybox has no alpha, and the PNG was 2.98 MB vs
// 665 KB here — it would have made the "lighter" mobile fallback 3.3x HEAVIER
// than the Draco arena it replaces.
import panoramaUrl from '../assets/sats-arena-gold-360-equirectangular.jpg?url';

/**
 * arena-glb.js — the "Imperial Gold" arena as a skin environment.
 *
 * Fills the `environment` slot the Prompt 30 seam defined. The seam is not
 * rebuilt: this is just a builder that happens to attach a loaded GLB.
 *
 * ── Contract from the asset's own integration notes (followed, not guessed) ──
 *   glTF is Y-up, in METRES. Floor origin [0,0,0]. Arena radius 12 m, wall
 *   height 7.8 m, ceiling max 11.2 m → a 24 m span, which is already the target
 *   size, so NO scale factor is applied. The primary gate faces the centre from
 *   the -Z wall. Desktop camera belongs at [0,1.65,0] (ours is [0,1.6,0], and
 *   the player already stands at the arena origin). In WebXR the rig sits at the
 *   floor origin and the headset supplies eye height — we add no second offset.
 *
 *   Hierarchy: SatsArena_Gold_v1 > { Environment_Gold, GameplayAnchors,
 *   PreviewLights }. Environment_Gold IS the shell (Floor / WallShell / Dome /
 *   Architecture / Gates / CeilingBoss), which is exactly the handle the AR
 *   shell-off rule needs.
 *
 * ── Validation ───────────────────────────────────────────────────────────────
 * The exporter's own validation.json claims a sealed interior (8192 rays, 0
 * misses). A render can lie, so validateFromInside() re-runs that test IN THIS
 * ENGINE against the actually-loaded geometry before the arena is accepted.
 * On a HARD failure we fall back automatically to the 360 panorama.
 *
 * ── Caching ──────────────────────────────────────────────────────────────────
 * The GLB is parsed ONCE and the same root is re-parented on every switch. It
 * is marked userData.keepAlive so the seam's teardown detaches instead of
 * disposing it — re-parsing 7 MB on every swap would make switching feel broken.
 */

// Hard-failure thresholds. Cross either and we fall back to the panorama.
const SEAL_RAYS          = 4096;  // rays cast from the player's eye point
const SEAL_MISS_TOLERANCE = 0.005; // >0.5% escaping = not sealed
const MIN_SPAN_M         = 12;    // smaller than this = doll-house
const MAX_SPAN_M         = 60;    // larger than this = cathedral
const MAX_TRIANGLES      = 250000; // above this we consider the budget blown

const EYE = new THREE.Vector3(0, 1.65, 0); // the notes' reference camera point

/**
 * Should this device attempt the 140k-triangle GLB arena at all?
 *
 * Decided by CAPABILITY, not by hoping a phone copes. A handheld running the
 * flat/AR path has to carry the arena on a mobile GPU with a mobile thermal
 * budget, on top of the gun and coins — and it gets no stereo benefit from the
 * geometry. Those devices take the 360 panorama instead, which is the fallback
 * P31 already built and validated.
 *
 * Headsets are NOT excluded: Quest reports coarse pointer + touch but is exactly
 * where the real geometry matters, so an XR-capable device always gets the GLB.
 * Desktop always gets it. Override either way with ?arena=glb / ?arena=pano.
 */
export async function preferGlbArena() {
  const q = new URLSearchParams(location.search).get('arena');
  if (q === 'glb')  return true;
  if (q === 'pano') return false;

  // HEADSET TEST — deliberately immersive-VR support, NOT the mere presence of
  // navigator.xr. Android Chrome exposes navigator.xr for immersive-AR, so
  // "has navigator.xr" would hand every Android phone the 140k-triangle arena,
  // which is exactly the device this gate exists to protect. Quest supports
  // immersive-vr; phones generally do not.
  try {
    if (navigator.xr?.isSessionSupported && await navigator.xr.isSessionSupported('immersive-vr')) return true;
  } catch { /* treat a probe failure as "not a headset" */ }

  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const smallish = Math.min(screen.width, screen.height) < 820;
  const lowCores = (navigator.hardwareConcurrency || 8) <= 4;
  const lowMem   = (navigator.deviceMemory || 8) <= 4;

  const handheld = coarse && smallish;
  return !(handheld || (lowCores && lowMem));
}

let _state = {
  status: 'idle',      // idle | loading | ready | failed
  source: null,        // 'glb' | 'panorama'
  root: null,          // the object to parent into a skin group
  shell: null,         // Environment_Gold (or the panorama sphere)
  diagnostics: null,
};
let _promise = null;
const _readyCbs = [];

export function getArenaState()       { return _state; }
export function isArenaReady()        { return _state.status === 'ready'; }
export function getArenaDiagnostics() { return _state.diagnostics; }
export function onArenaReady(cb)      { _readyCbs.push(cb); if (isArenaReady()) cb(_state); }

/** Idempotent. Starts (or returns) the load. */
export function loadArena() {
  if (_promise) return _promise;
  _state.status = 'loading';
  _promise = _load().then((s) => {
    _state = s;
    _readyCbs.forEach((cb) => { try { cb(_state); } catch (e) { console.warn('[arena] ready cb', e); } });
    return _state;
  });
  return _promise;
}

/** Resolves once the arena (GLB or fallback) is built and attachable. */
export function whenArenaReady() { return loadArena(); }

async function _load() {
  const t0 = performance.now();

  // Capability gate FIRST — on a handheld this skips the GLB download entirely
  // rather than fetching it and then deciding.
  if (!(await preferGlbArena())) {
    console.log('[arena] handheld/low-capability device → 360 panorama arena');
    return buildPanorama({ reason: 'device capability gate (handheld or low-spec)' });
  }

  try {
    const loader = new GLTFLoader();
    // The runtime arena GLB is Draco-compressed (7.48 MB -> 891 KB). Reuse the
    // decoder weapon.js already self-hosts in public/draco/ — no CDN, and it is
    // usually warm in cache because the gun loads first.
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(arenaGlbUrl);
    const root = gltf.scene;
    root.name = 'SatsArena_Gold_v1';

    const shell = root.getObjectByName('Environment_Gold') || root;
    const diag  = inspect(root, shell);
    diag.loadMs = Math.round(performance.now() - t0);

    // ── The checks that decide GLB vs panorama ───────────────────────────────
    const seal  = validateFromInside(shell);
    diag.seal   = seal;
    const span  = Math.max(diag.sizeMetres.x, diag.sizeMetres.z);

    const failures = [];
    if (seal.missRatio > SEAL_MISS_TOLERANCE) failures.push(`not sealed (${(seal.missRatio*100).toFixed(2)}% of rays escaped)`);
    if (span < MIN_SPAN_M || span > MAX_SPAN_M) failures.push(`scale out of range (${span.toFixed(1)} m span)`);
    if (diag.triangles > MAX_TRIANGLES)        failures.push(`over triangle budget (${diag.triangles})`);
    diag.failures = failures;

    if (failures.length) {
      console.warn('[arena] GLB failed hard checks → panorama fallback:', failures);
      return buildPanorama({ reason: failures.join('; '), glbDiagnostics: diag });
    }

    prepareForRuntime(root);
    root.userData.keepAlive = true; // the seam detaches rather than disposes this

    console.log(`[arena] GLB accepted — ${diag.triangles} tris, ${diag.sizeMetres.x}×${diag.sizeMetres.z} m, seal ${seal.misses}/${seal.rays} misses`);
    return { status: 'ready', source: 'glb', root, shell, diagnostics: diag };
  } catch (err) {
    console.warn('[arena] GLB load failed → panorama fallback', err);
    return buildPanorama({ reason: `GLB load error: ${err?.message || err}` });
  }
}

// ── In-engine validation ──────────────────────────────────────────────────────

/**
 * SEALED CHECK, done from INSIDE with the real loaded geometry.
 * Casts rays outward from the player's eye point over an evenly distributed
 * sphere (Fibonacci) and counts how many escape without hitting anything.
 * A single gap to the void shows up here even when a render looks solid.
 */
export function validateFromInside(shell, rays = SEAL_RAYS) {
  const raycaster = new THREE.Raycaster();
  raycaster.far = 200;
  const dir = new THREE.Vector3();
  let misses = 0, minDist = Infinity, maxDist = 0;

  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < rays; i++) {
    // Even sphere distribution — no clustering at the poles.
    const y = 1 - (i / (rays - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    dir.set(Math.cos(th) * r, y, Math.sin(th) * r).normalize();

    raycaster.set(EYE, dir);
    const hit = raycaster.intersectObject(shell, true)[0];
    if (!hit) { misses++; continue; }
    if (hit.distance < minDist) minDist = hit.distance;
    if (hit.distance > maxDist) maxDist = hit.distance;
  }
  return {
    rays, misses,
    missRatio: misses / rays,
    sealed: misses / rays <= SEAL_MISS_TOLERANCE,
    minDistanceM: Number.isFinite(minDist) ? +minDist.toFixed(3) : null,
    maxDistanceM: +maxDist.toFixed(3),
  };
}

function inspect(root, shell) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(shell);
  const size = box.getSize(new THREE.Vector3());

  let triangles = 0, meshes = 0, doubleSided = 0, materials = new Set();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    meshes++;
    const g = o.geometry;
    triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      materials.add(m.name || m.uuid);
      if (m.side === THREE.DoubleSide) doubleSided++;
    }
  });

  return {
    triangles: Math.round(triangles),
    meshes,
    materials: materials.size,
    doubleSidedMaterialSlots: doubleSided,
    sizeMetres: { x: +size.x.toFixed(2), y: +size.y.toFixed(2), z: +size.z.toFixed(2) },
    floorY: +box.min.y.toFixed(3),
    ceilingY: +box.max.y.toFixed(3),
    hasPlayerOrigin: !!root.getObjectByName('PlayerOrigin'),
    targetAnchors: (() => { let n = 0; root.traverse(o => { if (o.name?.startsWith('Target_')) n++; }); return n; })(),
  };
}

function prepareForRuntime(root) {
  // The notes: add a modest ambient fill for an enclosed space. Scoped to the
  // arena so the classic skin's look is untouched.
  const fill = new THREE.HemisphereLight(0xffe0b0, 0x29231d, 0.45);
  fill.name = 'ArenaFill';
  root.add(fill);

  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;   // no shadow maps configured; keep it cheap on Quest
    o.frustumCulled = true;
  });
  root.updateMatrixWorld(true);
}

// ── Panorama fallback ─────────────────────────────────────────────────────────

/**
 * The documented fallback: a 2048x1024 equirectangular render of THIS arena,
 * mapped to the inside of a sphere (BackSide). Only used if the GLB fails a
 * hard check — a backdrop cannot supply parallax, so it is strictly second best.
 */
function buildPanorama(info) {
  const root = new THREE.Group();
  root.name = 'SatsArena_Panorama';

  const tex = new THREE.TextureLoader().load(panoramaUrl);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;

  // Radius comfortably beyond the play space; BackSide = we see the inside.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(40, 48, 32),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false }),
  );
  sphere.name = 'PanoramaShell';
  sphere.renderOrder = -1;
  // Centre longitude points along -Z in the source render, matching the GLB's
  // front vault, so no yaw correction is needed.
  root.add(sphere);

  // NADIR COVER. The source panorama's nadir row is uniform (verified 0
  // variation by the exporter), so there is no swirl artifact — but a flat
  // uniform colour directly underfoot still reads as "no floor". A small disc
  // with the Bitcoin mark gives the eye something to stand on.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(6, 48),
    new THREE.MeshBasicMaterial({ map: makeNadirTexture(), transparent: true }),
  );
  disc.name = 'NadirDisc';
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.02; // just above the floor plane to avoid z-fighting
  root.add(disc);

  root.userData.keepAlive = true;
  return {
    status: 'ready',
    source: 'panorama',
    root,
    shell: root,
    diagnostics: { ...info, panorama: { radius: 40, nadirCover: true } },
  };
}

/** Radial gold gradient with a ₿ mark — hides the nadir and reads as a floor. */
function makeNadirTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');

  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S / 2);
  g.addColorStop(0,    'rgba(38,30,16,1)');
  g.addColorStop(0.65, 'rgba(30,24,14,0.92)');
  g.addColorStop(1,    'rgba(24,20,12,0)'); // fade out so the seam is invisible
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = 'rgba(247,147,26,0.45)';
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(S / 2, S / 2, S * 0.34, 0, Math.PI * 2); ctx.stroke();

  ctx.fillStyle = 'rgba(247,147,26,0.75)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(S * 0.30)}px monospace`;
  ctx.fillText('₿', S / 2, S / 2 + S * 0.01);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ── AR shell suppression ──────────────────────────────────────────────────────
/**
 * Hide/show the arena SHELL (walls, floor, dome, gates) for AR passthrough.
 *
 * In practice the skin group already lives under the scene's `environment`
 * group, which armode.js hides wholesale in passthrough — so the arena is
 * already suppressed there. This is the explicit, named control for it, and it
 * keeps working if the arena ever gains freestanding props that SHOULD remain
 * visible in AR (they would live outside `shell`).
 */
export function setArenaShellVisible(visible) {
  if (_state.shell) _state.shell.visible = visible;
}

/** Attach the loaded arena into a skin group. Synchronous once ready. */
export function attachArenaInto(group) {
  if (!_state.root) return false;
  group.add(_state.root); // re-parents from any previous skin group
  return true;
}
