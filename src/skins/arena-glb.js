import * as THREE from 'three';
// GLTFLoader/DRACOLoader are imported DYNAMICALLY inside _load(). They are ~52 KB
// of three/addons that nothing on the first-frame path touches, and pulling them
// in statically put that parse cost in front of the player's first frame.
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
 * SEAL VALIDATION IS A QA TOOL, NOT A PER-LOAD RUNTIME COST.
 *
 * PROFILED (Prompt 39): validateFromInside() was the single longest main-thread
 * task in the whole boot — 18.4 s in a headless Chrome CPU profile on an Apple
 * Silicon Mac, inside ONE uninterruptible task. It casts SEAL_RAYS rays at a
 * 140,104-triangle mesh that has no acceleration structure, so every ray is a
 * brute-force scan of every triangle: 4096 x 140k = ~574 million ray/triangle
 * tests, synchronously, on the main thread, in the GLTFLoader onLoad callback.
 * The render loop stopped dead for the whole of it. That is the "loads for ages,
 * nothing moves" freeze.
 *
 * The asset is FIXED and SHIPPED, and it already passed this exact check —
 * "seal 0/4096 misses", recorded below. Re-deriving that constant on every
 * player's phone, every load, buys nothing. So the check now runs only in dev or
 * with ?validate in the URL, which is where a NEW arena asset gets vetted, and
 * even then it runs time-sliced so it can never block a frame again.
 *
 * The cheap structural checks (span, triangle budget) still run on every load —
 * they are a single pass over the geometry, not a ray cast per triangle.
 */
const ARENA_VALIDATE = (() => {
  try {
    return import.meta.env.DEV || new URLSearchParams(location.search).has('validate');
  } catch { return false; }
})();

// The recorded QA result for the shipped v1 asset, reported in diagnostics so
// production still says what the seal state IS rather than going silent on it.
const SEAL_QA_RESULT = { rays: 4096, misses: 0, missRatio: 0, sealed: true, source: 'QA (validated in-engine, ?validate to re-run)' };

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
export function preferGlbArena() {
  const q = new URLSearchParams(location.search).get('arena');
  if (q === 'glb')  return true;
  if (q === 'pano') return false;   // dev flag: force the fallback to inspect it

  // The GLB IS the default, on every device including phones.
  //
  // The previous gate asked "is this a phone?" (coarse pointer + small screen)
  // and treated immersive-VR support as a capability signal. Both were wrong:
  // phones rendered this arena correctly before it was ever gated, the model is
  // now 891 KB and loads asynchronously, and immersive-vr support is a HEADSET
  // question, not a "can this GPU draw 136k triangles" question. iPhones report
  // no immersive-vr, so every iPhone was being handed the fallback — which is
  // the regression this replaces.
  //
  // The panorama is now reserved for the two cases that actually justify it:
  //   1. a genuine GLB load/validation failure (handled in _load's catch), and
  //   2. a device that MEASURES as weak.
  // Thresholds are deliberately severe, and unknown is never treated as weak —
  // Safari does not implement deviceMemory at all, so `|| 8` style defaults
  // would silently mis-gate every iPhone again.
  const mem   = navigator.deviceMemory;          // undefined on iOS Safari
  const cores = navigator.hardwareConcurrency;   // undefined on some browsers
  const weakMemory = typeof mem === 'number' && mem <= 2;
  const weakCpu    = typeof cores === 'number' && cores <= 2;

  return !(weakMemory || weakCpu);
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

/**
 * SHADER PRE-COMPILATION CONTEXT.
 *
 * The arena brings ~20 primitives across 4 materials that the renderer has never
 * seen. Without this, all of those programs are compiled and linked on the FIRST
 * frame that shows the arena — a synchronous GL stall right at the moment the
 * player switches skin, which reads as "frozen, then everything appears".
 * renderer.compileAsync() builds them ahead of time, off that frame, using the
 * real scene so lights and fog resolve to the same program variants.
 * main.js supplies this; if nothing does, warming is simply skipped.
 */
let _gl = null;
export function setArenaRenderContext(ctx) { _gl = ctx; }

/**
 * Yield the main thread until the next frame — the unit of time-slicing used by
 * both the texture warm-up and the seal validator.
 *
 * requestAnimationFrame is SUSPENDED while the document is hidden, so a page
 * opened in a background tab would sit in a slice loop forever and never report
 * the arena ready. When hidden we fall back to a macrotask, which still yields
 * (nothing is being rendered to stall) and lets the work finish.
 */
function yieldFrame() {
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }
  return new Promise((r) => setTimeout(r, 0));
}

async function warmShaders(root, label) {
  if (!_gl?.renderer) return null;
  const t = performance.now();
  try {
    if (_gl.renderer.compileAsync) {
      await _gl.renderer.compileAsync(root, _gl.camera, _gl.scene);
    }
    await warmTextures(root);
    const ms = Math.round(performance.now() - t);
    console.log(`[arena] GPU warm-up for ${label}: ${ms}ms (shaders + textures, off the render frame)`);
    return ms;
  } catch (e) {
    // Never let a warm-up failure cost us the arena.
    console.warn('[arena] GPU warm-up skipped', e);
    return null;
  }
}

/**
 * STAGGERED TEXTURE UPLOAD.
 *
 * Compiling the programs is only half of the first-frame stall: each texture is
 * also decoded and uploaded to the GPU the first time it is drawn, all in the
 * same frame. initTexture() forces that upload now, and doing them ONE PER FRAME
 * spreads the cost instead of trading one long stall for another.
 */
async function warmTextures(root) {
  const renderer = _gl?.renderer;
  if (!renderer?.initTexture) return;
  const seen = new Set();
  const texes = [];
  root.traverse((o) => {
    for (const m of (Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []))) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
        const t = m?.[k];
        if (t?.isTexture && !seen.has(t.uuid)) { seen.add(t.uuid); texes.push(t); }
      }
    }
  });
  for (const t of texes) {
    try { renderer.initTexture(t); } catch { /* a texture we can't pre-upload is not fatal */ }
    await yieldFrame();
  }
}

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
  if (!preferGlbArena()) {
    console.log('[arena] device measures as weak → 360 panorama arena');
    return buildPanorama({ reason: 'measured low-capability device (<=2GB RAM or <=2 cores)' });
  }

  try {
    // Loader code is fetched on demand — see the import note at the top.
    const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/loaders/DRACOLoader.js'),
    ]);
    const loader = new GLTFLoader();
    // The runtime arena GLB is Draco-compressed (7.48 MB -> 891 KB). Reuse the
    // decoder weapon.js already self-hosts in public/draco/ — no CDN, and it is
    // usually warm in cache because the gun loads first.
    //
    // DECODE IS OFF THE MAIN THREAD, and the Prompt 39 trace proves it: the Draco
    // decode never appears as a main-thread task, it arrives back as a worker
    // postMessage. What WAS on the main thread was everything we then did inside
    // that message handler — which is what the time-slicing below fixes.
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    // Spin the decoder worker up now rather than at first-use, so the decode
    // starts the moment the bytes land instead of after a cold worker boot.
    draco.preload();
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(arenaGlbUrl);
    const root = gltf.scene;
    root.name = 'SatsArena_Gold_v1';

    const shell = root.getObjectByName('Environment_Gold') || root;
    const diag  = inspect(root, shell);
    diag.loadMs = Math.round(performance.now() - t0);

    // ── The checks that decide GLB vs panorama ───────────────────────────────
    // Cheap structural checks always; the ray-cast seal check only when asked
    // for (see ARENA_VALIDATE above — it was an 18 s main-thread stall).
    const seal  = ARENA_VALIDATE ? await validateFromInside(shell) : { ...SEAL_QA_RESULT, skipped: true };
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
    diag.warmMs = await warmShaders(root, 'GLB arena');

    console.log(`[arena] GLB accepted — ${diag.triangles} tris, ${diag.sizeMetres.x}×${diag.sizeMetres.z} m, seal ${seal.misses}/${seal.rays} misses${seal.skipped ? ' (QA-recorded; ?validate to re-run in-engine)' : ' (re-run in-engine)'}`);
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
export async function validateFromInside(shell, rays = SEAL_RAYS, { sliceMs = 4 } = {}) {
  const raycaster = new THREE.Raycaster();
  raycaster.far = 200;
  const dir = new THREE.Vector3();
  let misses = 0, minDist = Infinity, maxDist = 0;

  // TIME-SLICED. A single ray against this un-accelerated 140k-triangle shell
  // costs ~4.5 ms, so the old synchronous loop owned the main thread for the
  // whole sweep. Yielding every `sliceMs` keeps each slice inside one frame's
  // budget: the sweep still takes as long as it takes, but the render loop,
  // input and the mode switcher all keep running through it.
  const t0 = performance.now();
  let sliceStart = t0;

  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < rays; i++) {
    // Even sphere distribution — no clustering at the poles.
    const y = 1 - (i / (rays - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    dir.set(Math.cos(th) * r, y, Math.sin(th) * r).normalize();

    raycaster.set(EYE, dir);
    const hit = raycaster.intersectObject(shell, true)[0];
    if (!hit) { misses++; }
    else {
      if (hit.distance < minDist) minDist = hit.distance;
      if (hit.distance > maxDist) maxDist = hit.distance;
    }

    if (performance.now() - sliceStart >= sliceMs) {
      await yieldFrame();
      sliceStart = performance.now();
    }
  }
  return {
    rays, misses,
    missRatio: misses / rays,
    sealed: misses / rays <= SEAL_MISS_TOLERANCE,
    minDistanceM: Number.isFinite(minDist) ? +minDist.toFixed(3) : null,
    maxDistanceM: +maxDist.toFixed(3),
    elapsedMs: Math.round(performance.now() - t0),
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
  // NOT EquirectangularReflectionMapping: that mapping is for envMaps/reflections.
  // This texture is a plain `map` on UV-mapped sphere geometry, so it must stay
  // on the default UVMapping or it samples wrongly.

  // INVERTED GEOMETRY, not BackSide. Viewing a sphere's interior through
  // side:BackSide shows the texture from behind, which MIRRORS it — that is why
  // the arena read "flipped" and the signage was backwards. Scaling the geometry
  // by -1 on X turns the sphere inside out instead, so we see the interior with
  // the texture the right way round. This is the canonical three.js equirect
  // recipe and it keeps the default FrontSide material.
  const geo = new THREE.SphereGeometry(40, 48, 32);
  geo.scale(-1, 1, 1);

  const sphere = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: tex,
    depthWrite: false,
    // UNLIT (MeshBasicMaterial) so it is at full brightness with no lights, AND
    // fog:false. scene.fog is Fog(10, 40) and this shell sits at radius 40 —
    // exactly fog.far — so with fog enabled the entire panorama was faded to the
    // near-black background. THAT is why it rendered dark. Opting this material
    // out of fog fixes it without touching scene.fog (still owned by armode.js).
    fog: false,
  }));
  sphere.name = 'PanoramaShell';
  sphere.renderOrder = -1;
  sphere.frustumCulled = false;
  // Centre longitude points along -Z in the source render, matching the GLB's
  // front vault, so no yaw correction is needed.
  root.add(sphere);

  // NADIR COVER. The source panorama's nadir row is uniform (verified 0
  // variation by the exporter), so there is no swirl artifact — but a flat
  // uniform colour directly underfoot still reads as "no floor". A small disc
  // with the Bitcoin mark gives the eye something to stand on.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(9, 48),
    new THREE.MeshBasicMaterial({
      map: makeNadirTexture(), transparent: true, depthWrite: false, fog: false,
    }),
  );
  disc.name = 'NadirDisc';
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.02; // just above the floor plane to avoid z-fighting
  disc.frustumCulled = false;
  root.add(disc);

  root.userData.keepAlive = true;
  // Warm the panorama's one material too — same reason, much cheaper.
  warmShaders(root, 'panorama');
  return {
    status: 'ready',
    source: 'panorama',
    root,
    shell: root,
    diagnostics: { ...info, panorama: { radius: 40, nadirCover: true } },
  };
}

/**
 * Nadir cover: a soft dark disc that hides the pole directly underfoot.
 *
 * NO ₿ GLYPH. The first version drew a large Bitcoin mark here, which is what
 * appeared as "a ₿ lying on the floor" — a decal on the ground reads as a
 * mistake, not as branding. Branding belongs on the gate and the dome. This is
 * now purely a gradient that fades out at its edge so the seam is invisible.
 */
function makeNadirTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');

  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.04, S / 2, S / 2, S / 2);
  g.addColorStop(0,    'rgba(34,27,15,1)');
  g.addColorStop(0.55, 'rgba(30,24,14,0.86)');
  g.addColorStop(1,    'rgba(24,20,12,0)'); // fade out so the edge is invisible
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ctx.fill();

  // A single faint ring gives the eye a floor plane to sit on, without reading
  // as a logo stamped on the ground.
  ctx.strokeStyle = 'rgba(247,147,26,0.18)';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(S / 2, S / 2, S * 0.40, 0, Math.PI * 2); ctx.stroke();

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
