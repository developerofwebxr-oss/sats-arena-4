import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import gunModelUrl from './assets/sats-arena-better-gun.glb?url';

/**
 * weapon.js — a fancy Bitcoin-themed first-person blaster loaded from a GLB.
 *
 * The model is loaded ONCE via GLTFLoader and reused. It rides inside a "weapon"
 * Group whose placement (vs. the camera in flat mode, vs. the controller in VR)
 * is unchanged from the original blaster — only the visual model is swapped. The
 * muzzle flash and all shooting/raycasting logic are untouched.
 *
 * Placement:
 *   Desktop / mobile → child of the camera, parked bottom-center-right.
 *   Quest VR         → reparented to controller 0 so it rides the hand.
 *
 * Public API:
 *   setupWeapon(camera, renderer) → { updateWeapon(delta), flashMuzzle(), setHidden() }
 */

// Muzzle flash fades from full to zero over this many seconds.
const FLASH_DURATION = 0.12;

// ── Whole-weapon placement (UNCHANGED from the original blaster) ─────────────
// These position/scale the entire weapon group; the model sits inside it.

// Where the gun sits when parented to the camera (flat view).
// Mobile uses a SMALLER x offset: a narrow portrait aspect has a tight
// horizontal FOV, so the desktop x (0.22) shoves the gun against the right edge.
// Pulling x in brings it more into view on phones. Desktop x is unchanged.
const CAMERA_POS        = new THREE.Vector3(0.22, -0.20, -0.55);
const CAMERA_POS_MOBILE = new THREE.Vector3(0.10, -0.20, -0.55); // pulled left for phones
const CAMERA_EULER = new THREE.Euler(0.05, -0.08, 0); // slight inward tilt
const CAMERA_SCALE = 1.0;

// Coarse pointer or a small min-dimension → treat as a phone for gun placement.
// TEMP debug override (?gunmobile=1 / ?gundesktop=1) lets us verify each
// placement on desktop; removed with the [gun] diagnostics before promotion.
function isMobileView() {
  const q = new URLSearchParams(window.location.search);
  if (q.get('gunmobile') === '1') return true;
  if (q.get('gundesktop') === '1') return false;
  return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
         Math.min(window.innerWidth, window.innerHeight) < 600;
}

// Where the gun sits when parented to the controller in VR.
// Smaller and centred on the controller, pointing forward (−Z).
const VR_POS   = new THREE.Vector3(0, -0.02, -0.05);
const VR_EULER = new THREE.Euler(0, 0, 0);
const VR_SCALE = 0.7;

// ── GLB model fit (TUNE THESE on-device) ─────────────────────────────────────
// Correct the imported model's own size / origin / orientation so it sits like a
// held gun (barrel pointing forward along −Z). These apply to the model INSIDE
// the weapon group, so adjusting them never disturbs the placement above.
// Raw model is 1.152 × 0.571 × 0.204 m (measured): its long axis is X, so the
// barrel points sideways — rotate 90° about Y to face it forward (−Z). Vertical
// center ≈ 0.285, so it sits LOW within the group (rising from the bottom edge)
// like the old blaster. Scale slightly larger than the previous gun.
const MODEL_SCALE = 0.50;                          // slightly larger than the last gun (0.46)
const MODEL_POS   = new THREE.Vector3(0, -0.26, 0); // pushed down to the bottom edge
const MODEL_EULER = new THREE.Euler(0, Math.PI / 2, 0); // long axis X → forward −Z

// Muzzle-flash placement at the (new) barrel tip + its size — tune to the model's
// muzzle. Kept as constants for easy on-device adjustment.
const FLASH_POS  = new THREE.Vector3(0, -0.10, -0.36); // at the new model's muzzle tip
const FLASH_SIZE = 0.62; // world-space sprite size of the bang burst

// One shared loader for the whole app. The GLB is Draco-compressed, so a
// DRACOLoader is required to decode its geometry. The decoder is self-hosted in
// public/draco/ (no CDN dependency — works offline at the venue); served at the
// build's base path via BASE_URL so it resolves on both test and live.
const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
gltfLoader.setDRACOLoader(dracoLoader);

// ── Peer-gun clone API ────────────────────────────────────────────────────────
// peer-avatars.js calls cloneGun() to get a clone of the loaded model scene for
// a peer's right hand. Resolves once the GLB has loaded; safe to call before load.
// NEVER returns the original — always a deep clone so per-peer material changes
// or disposal never affect the player's own weapon.
let _gunLoadedResolve;
const _gunLoadedPromise = new Promise((r) => { _gunLoadedResolve = r; });
let _loadedGunScene = null; // set in the gltfLoader success callback below

export async function cloneGun() {
  await _gunLoadedPromise;
  return _loadedGunScene.clone(true); // deep clone: own Object3D hierarchy, shared geometry buffers
}

export function setupWeapon(camera, renderer) {
  // ── Muzzle flash ────────────────────────────────────────────────────────────
  // A billboarded SPRITE carrying a jagged star-burst texture — reads as an energy
  // "bang", not a square. A Sprite always faces the camera, so it looks identical
  // in flat, mobile, VR, and AR and can never go edge-on invisible. Additive
  // gold/orange glow, invisible until a shot fires.
  const flashMat = new THREE.SpriteMaterial({
    map: createMuzzleTexture(),
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false, // always draw on top of the barrel so it's never occluded
  });
  const flash = new THREE.Sprite(flashMat);
  flash.position.copy(FLASH_POS);     // at the barrel tip
  flash.scale.set(FLASH_SIZE, FLASH_SIZE, 1);
  flash.frustumCulled = false;        // first-person, always on screen
  flash.visible = false;

  // ── Group everything ────────────────────────────────────────────────────────
  // The group holds the muzzle flash immediately; the GLB model is added into it
  // once it finishes loading (below). Placement isn't blocked on the load.
  const weapon = new THREE.Group();
  weapon.add(flash);

  // ── Dedicated gun lighting ───────────────────────────────────────────────────
  // The model uses PBR (MeshPhysicalMaterial) and the scene is near-black, so it
  // looked dark/muddy. These lights are CHILDREN of the weapon group, so they
  // ride with the gun in flat, VR, and AR (where the environment is hidden) and
  // light only the gun's neighbourhood. Warm key + cool fill make the Bitcoin
  // gold/details read crisply. Tune intensities here.
  const KEY_INTENSITY  = 8;
  const FILL_INTENSITY = 4;
  const LIGHT_DISTANCE = 2;   // metres — kept local so it doesn't wash the scene
  const gunKey = new THREE.PointLight(0xfff2dd, KEY_INTENSITY, LIGHT_DISTANCE, 2);
  gunKey.position.set(0.25, 0.35, 0.2);   // above / front / right of the gun
  const gunFill = new THREE.PointLight(0x9fd8ff, FILL_INTENSITY, LIGHT_DISTANCE, 2);
  gunFill.position.set(-0.3, 0.0, 0.3);   // opposite side, softer cool fill
  weapon.add(gunKey, gunFill);

  // ── Load the GLB gun model (once) ────────────────────────────────────────────
  // Loaded a single time and reused. Added into the weapon group when ready, so a
  // slow load never delays attachment — the model just pops in sub-second.
  console.log('[gun] loading GLB from', gunModelUrl);
  gltfLoader.load(
    gunModelUrl,
    (gltf) => {
      // Snapshot the raw scene BEFORE applying player-weapon transforms so
      // cloneGun() gives peers a clean, unpositioned copy they can place freely.
      _loadedGunScene = gltf.scene.clone(true);
      _gunLoadedResolve();

      const model = gltf.scene;

      // ── DIAGNOSTICS ──────────────────────────────────────────────────────────
      // Measure the model BEFORE we scale it, so we know its true authored size,
      // and inspect its meshes/materials to rule out a material/lighting issue.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      let meshCount = 0;
      const mats = new Set();
      model.traverse((o) => {
        if (o.isMesh) {
          meshCount++;
          const m = o.material;
          (Array.isArray(m) ? m : [m]).forEach((mat) => mat && mats.add(mat.type));
        }
      });
      console.log('[gun] LOADED ✓ ' + JSON.stringify({
        rawSize: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
        center: [+center.x.toFixed(3), +center.y.toFixed(3), +center.z.toFixed(3)],
        meshCount,
        materials: [...mats],
        willScaleBy: MODEL_SCALE,
      }));

      model.position.copy(MODEL_POS);
      model.rotation.copy(MODEL_EULER);
      model.scale.setScalar(MODEL_SCALE);
      // First-person object — always on screen, so skip frustum culling to avoid
      // any cull "pop", and don't let it cast/receive shadows (cheap on Quest).
      model.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false;
          o.castShadow = false;
          o.receiveShadow = false;
        }
      });
      weapon.add(model);
      console.log('[gun] added to weapon group; group children =', weapon.children.length);
    },
    (p) => {
      if (p.total) console.log(`[gun] loading ${Math.round((p.loaded / p.total) * 100)}%`);
    },
    (err) => console.error('[gun] LOAD FAILED ✗', err),
  );

  // Start parented to the camera (flat mode).
  attachToCamera();

  function attachToCamera() {
    camera.add(weapon);
    weapon.position.copy(isMobileView() ? CAMERA_POS_MOBILE : CAMERA_POS);
    weapon.rotation.copy(CAMERA_EULER);
    weapon.scale.setScalar(CAMERA_SCALE);
  }

  function attachToControllerGroup(controller) {
    controller.add(weapon); // getController() returns the same Group xr.js uses
    weapon.position.copy(VR_POS);
    weapon.rotation.copy(VR_EULER);
    weapon.scale.setScalar(VR_SCALE);
  }

  // The blaster rides the RIGHT hand (most players are right-handed). Handedness is
  // only known on a controller's 'connected' event, so we attach there. On session
  // start we attach to controller 0 as a fallback (so the gun is always on a hand),
  // then move it to the right controller once that one reports in.
  renderer.xr.addEventListener('sessionstart', () => {
    attachToControllerGroup(renderer.xr.getController(0));
  });
  renderer.xr.addEventListener('sessionend', attachToCamera);

  [0, 1].forEach((i) => {
    renderer.xr.getController(i).addEventListener('connected', (e) => {
      if (e.data && e.data.handedness === 'right') {
        attachToControllerGroup(renderer.xr.getController(i));
      }
    });
  });

  // ── Muzzle flash state ──────────────────────────────────────────────────────
  let flashAge = FLASH_DURATION; // start "expired" so it's hidden

  /** Trigger the muzzle flash. Called on every shot fired. */
  function flashMuzzle() {
    flashAge = 0;
    flash.visible = true;
    flash.material.opacity = 1;
    // Spin + size jitter so repeated bangs never look identical.
    flash.material.rotation = Math.random() * Math.PI * 2;
    const j = FLASH_SIZE * (0.85 + Math.random() * 0.4);
    flash.scale.set(j, j, 1);
  }

  /** Called every frame. Fades the muzzle flash out. */
  function updateWeapon(delta) {
    if (!flash.visible) return;

    flashAge += delta;
    if (flashAge >= FLASH_DURATION) {
      flash.visible = false;
      flash.material.opacity = 0;
    } else {
      flash.material.opacity = 1 - flashAge / FLASH_DURATION;
    }
  }

  /**
   * setHidden(bool) — hide/show the whole weapon.
   * Used to hide the blaster on handheld phone AR, where there's no hand or
   * controller for it to ride and it would just occlude the small screen.
   */
  function setHidden(hidden) {
    weapon.visible = !hidden;
  }

  return { updateWeapon, flashMuzzle, setHidden };
}

// ── Muzzle-flash burst texture (drawn once, shared) ──────────────────────────────
// A jagged, irregular star-burst on a transparent background: a soft radial glow,
// an uneven multi-spike polygon (random spike lengths → not a clean star), and a
// hot white core. Gold/orange to match the neon/Bitcoin look. Additive blending
// on the sprite turns this into a glowing "bang".
function createMuzzleTexture() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx = S / 2, cy = S / 2;
  ctx.clearRect(0, 0, S, S);

  // Soft outer glow.
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, S / 2);
  glow.addColorStop(0, 'rgba(255,240,200,0.9)');
  glow.addColorStop(0.3, 'rgba(247,147,26,0.7)');
  glow.addColorStop(0.7, 'rgba(247,147,26,0.18)');
  glow.addColorStop(1, 'rgba(247,147,26,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, S / 2, 0, Math.PI * 2);
  ctx.fill();

  // Irregular spiky burst — alternating long/short points with random jitter.
  const spikes = 13;
  const outer = S * 0.48;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (i / (spikes * 2)) * Math.PI * 2;
    const isOuter = i % 2 === 0;
    const r = isOuter
      ? outer * (0.6 + Math.random() * 0.4)   // long spikes, uneven
      : S * (0.1 + Math.random() * 0.08);      // short inner notches
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  fill.addColorStop(0, 'rgba(255,255,255,1)');
  fill.addColorStop(0.35, 'rgba(255,205,100,0.98)');
  fill.addColorStop(1, 'rgba(247,147,26,0.6)'); // brighter tips so spikes read
  ctx.fillStyle = fill;
  ctx.fill();

  // Hot white core — kept small so the spiky shape dominates, not a white blob.
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
