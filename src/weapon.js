import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import gunModelUrl from './assets/sats-arena-better-gun.glb?url';

/**
 * weapon.js — a fancy Bitcoin-themed first-person blaster loaded from a GLB.
 *
 * Gun units:
 *   cameraGun      — child of camera; active in flat/mobile/AR.
 *   controllerGuns[0,1] — permanently attached to each XR controller from startup;
 *                         shown/hidden via 'connected'/'disconnected' events.
 *
 * Each gun is built by buildGunUnit() so it owns its own flash sprite, its own
 * SpriteMaterial (independent flash state), and its own PointLight pair.
 * The GLB is loaded once; cameraGun gets the raw scene, controller guns get
 * deep clones (shared geometry buffers — cheap).
 *
 * Public API:
 *   setupWeapon(camera, renderer)
 *     → { updateWeapon(delta), flashMuzzle(), notifyControllerFire(i), setLeftGunActive(bool), setHidden(bool) }
 */

// Muzzle flash fades from full to zero over this many seconds.
const FLASH_DURATION = 0.12;

// ── Camera (flat/mobile) placement ───────────────────────────────────────────
const CAMERA_POS        = new THREE.Vector3(0.22, -0.20, -0.55);
const CAMERA_POS_MOBILE = new THREE.Vector3(0.10, -0.20, -0.55);
const CAMERA_EULER      = new THREE.Euler(0.05, -0.08, 0);
const CAMERA_SCALE      = 1.0;

function isMobileView() {
  const q = new URLSearchParams(window.location.search);
  if (q.get('gunmobile') === '1') return true;
  if (q.get('gundesktop') === '1') return false;
  return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
         Math.min(window.innerWidth, window.innerHeight) < 600;
}

// ── Controller gun placement (group parented to controller) ──────────────────
const VR_POS   = new THREE.Vector3(0, -0.02, -0.05);
const VR_EULER = new THREE.Euler(0, 0, 0);
const VR_SCALE = 0.7;

// ── GLB model fit (inside each gun unit) ─────────────────────────────────────
// Barrel runs along +X; MODEL_EULER rotates it to face −Z (forward).
const MODEL_SCALE = 0.50;
const MODEL_POS   = new THREE.Vector3(0, -0.26, 0);
const MODEL_EULER = new THREE.Euler(0, Math.PI / 2, 0);

// ── Per-hand VR model orientation ────────────────────────────────────────────
// Lifted from sats-arena/src/weapon.js — same GLB, verified correct on Quest.
// Right: +180° extra yaw so barrel faces forward with trigger under the finger.
// Left: mirrored (negative X scale), so it needs the OPPOSITE sign (plain PI/2).
// Two independent constants — tuning one hand never touches the other.
const VR_MODEL_EULER      = new THREE.Euler(0, Math.PI / 2 + Math.PI, 0); // right (VERIFIED)
const VR_MODEL_EULER_LEFT = new THREE.Euler(0, Math.PI / 2, 0);           // left  (VERIFIED)
const MIRROR_LEFT = true; // negative X scale so the left gun isn't a backwards right gun

// ── Muzzle flash placement ────────────────────────────────────────────────────
const FLASH_POS  = new THREE.Vector3(0, -0.10, -0.36);
const FLASH_SIZE = 0.62;

// ── GLTFLoader (shared) ───────────────────────────────────────────────────────
const gltfLoader  = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
gltfLoader.setDRACOLoader(dracoLoader);

// ── Peer-gun clone API ────────────────────────────────────────────────────────
let _gunLoadedResolve;
const _gunLoadedPromise = new Promise((r) => { _gunLoadedResolve = r; });
let _loadedGunScene = null;

export async function cloneGun() {
  await _gunLoadedPromise;
  return _loadedGunScene.clone(true);
}

// ── setupWeapon ───────────────────────────────────────────────────────────────
export function setupWeapon(camera, renderer) {

  // Texture created once; each gun unit gets its own SpriteMaterial that shares
  // this texture read-only, so the flash state (opacity, rotation) is independent.
  const flashTex = createMuzzleTexture();

  // ── Gun unit factory ──────────────────────────────────────────────────────
  // Builds one self-contained gun: group + own flash sprite + own light pair.
  // The GLB model is added later via setModel() once loading finishes.
  function buildGunUnit(initialEuler = MODEL_EULER) {
    const group = new THREE.Group();

    // Each gun owns its SpriteMaterial so flash opacity/rotation is independent.
    const flashMat = new THREE.SpriteMaterial({
      map: flashTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    const flash = new THREE.Sprite(flashMat);
    flash.position.copy(FLASH_POS);
    flash.scale.set(FLASH_SIZE, FLASH_SIZE, 1);
    flash.visible = false;
    flash.frustumCulled = false;
    group.add(flash);

    // Own light pair so both guns are individually illuminated.
    const gunKey  = new THREE.PointLight(0xfff2dd, 8, 2, 2);
    gunKey.position.set(0.25, 0.35, 0.2);
    const gunFill = new THREE.PointLight(0x9fd8ff, 4, 2, 2);
    gunFill.position.set(-0.3, 0.0, 0.3);
    group.add(gunKey, gunFill);

    let _model  = null;
    let _mirror = false;
    let _euler  = initialEuler;

    function _applyTransform() {
      if (!_model) return;
      _model.position.copy(MODEL_POS);
      _model.rotation.copy(_euler);
      _model.scale.set(_mirror ? -MODEL_SCALE : MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    }

    function setModel(m) {
      _model = m;
      m.traverse((o) => {
        if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; }
      });
      _applyTransform();
      group.add(m);
    }

    function setMirror(b)      { _mirror = b; _applyTransform(); }
    function setModelEuler(e)  { _euler  = e; _applyTransform(); }

    // ── Flash state (per-unit) ──────────────────────────────────────────────
    let _flashAge = FLASH_DURATION; // start "expired"

    function flashMuzzle() {
      _flashAge = 0;
      flash.visible = true;
      flashMat.opacity = 1;
      flashMat.rotation = Math.random() * Math.PI * 2;
      const j = FLASH_SIZE * (0.85 + Math.random() * 0.4);
      flash.scale.set(j, j, 1);
    }

    function updateFlash(delta) {
      if (!flash.visible) return;
      _flashAge += delta;
      if (_flashAge >= FLASH_DURATION) {
        flash.visible = false;
        flashMat.opacity = 0;
      } else {
        flashMat.opacity = 1 - _flashAge / FLASH_DURATION;
      }
    }

    return { group, setModel, setMirror, setModelEuler, flashMuzzle, updateFlash };
  }

  // ── Create guns ───────────────────────────────────────────────────────────
  const cameraGun      = buildGunUnit(MODEL_EULER);
  const controllerGuns = [buildGunUnit(VR_MODEL_EULER), buildGunUnit(VR_MODEL_EULER)];

  // Camera gun: permanent camera child; visible in flat/mobile/AR.
  camera.add(cameraGun.group);
  cameraGun.group.position.copy(isMobileView() ? CAMERA_POS_MOBILE : CAMERA_POS);
  cameraGun.group.rotation.copy(CAMERA_EULER);
  cameraGun.group.scale.setScalar(CAMERA_SCALE);

  // Controller guns: permanently attached to their controller from startup;
  // hidden until the controller actually connects as a tracked-pointer device.
  controllerGuns.forEach((g, i) => {
    const c = renderer.xr.getController(i);
    c.add(g.group);
    g.group.position.copy(VR_POS);
    g.group.rotation.copy(VR_EULER);
    g.group.scale.setScalar(VR_SCALE);
    g.group.visible = false;
  });

  // ── Load GLB once; assign to guns ─────────────────────────────────────────
  console.log('[gun] loading GLB from', gunModelUrl);
  gltfLoader.load(
    gunModelUrl,
    (gltf) => {
      // Snapshot BEFORE transforms — peers get a clean, unpositioned copy.
      _loadedGunScene = gltf.scene.clone(true);
      _gunLoadedResolve();

      // Diagnostics (unchanged from before).
      const box    = new THREE.Box3().setFromObject(gltf.scene);
      const size   = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      let meshCount = 0;
      const mats = new Set();
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          meshCount++;
          const m = o.material;
          (Array.isArray(m) ? m : [m]).forEach((mat) => mat && mats.add(mat.type));
        }
      });
      console.log('[gun] LOADED ✓ ' + JSON.stringify({
        rawSize: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
        center:  [+center.x.toFixed(3), +center.y.toFixed(3), +center.z.toFixed(3)],
        meshCount,
        materials: [...mats],
        willScaleBy: MODEL_SCALE,
      }));

      // Camera gun gets the raw scene; controller guns get deep clones.
      cameraGun.setModel(gltf.scene);
      controllerGuns[0].setModel(gltf.scene.clone(true));
      controllerGuns[1].setModel(gltf.scene.clone(true));
    },
    (p) => { if (p.total) console.log(`[gun] loading ${Math.round((p.loaded / p.total) * 100)}%`); },
    (err) => console.error('[gun] LOAD FAILED ✗', err),
  );

  // ── VR session: show/hide camera gun ─────────────────────────────────────
  // Camera gun stays parented to camera the whole time; hidden during VR so
  // the controller guns (permanently on their controllers) take over visually.
  renderer.xr.addEventListener('sessionstart', () => { cameraGun.group.visible = false; });
  renderer.xr.addEventListener('sessionend',   () => { cameraGun.group.visible = true;  });

  // ── Fairness gate: left gun active/inactive ───────────────────────────────
  // setLeftGunActive(false) drops to right-hand-only when a flat peer is in the
  // session. Updates gun visibility instantly; fire is gated in notifyControllerFire.
  // Left-stick locomotion is NOT touched — only the gun visual + its trigger.
  let _leftGunActive      = true;
  let _leftControllerIndex = -1; // controller index whose handedness === 'left'

  function setLeftGunActive(active) {
    _leftGunActive = active;
    if (_leftControllerIndex >= 0) {
      controllerGuns[_leftControllerIndex].group.visible = active;
    }
  }

  // ── Per-hand orientation: set euler + mirror at connect time ──────────────
  // Controller index 0/1 is not reliably left/right — handedness comes from
  // event.data.handedness. Two separate euler constants so tuning one never
  // touches the other.
  [0, 1].forEach((i) => {
    renderer.xr.getController(i).addEventListener('connected', (e) => {
      const src = e.data;
      if (!src || src.targetRayMode !== 'tracked-pointer') return;
      const isLeft = src.handedness === 'left';
      if (isLeft) _leftControllerIndex = i;
      controllerGuns[i].setModelEuler(isLeft ? VR_MODEL_EULER_LEFT : VR_MODEL_EULER);
      controllerGuns[i].setMirror(isLeft && MIRROR_LEFT);
      // Respect the fairness gate if it was set before this controller connected.
      controllerGuns[i].group.visible = isLeft ? _leftGunActive : true;
    });
    renderer.xr.getController(i).addEventListener('disconnected', () => {
      if (i === _leftControllerIndex) _leftControllerIndex = -1;
      controllerGuns[i].group.visible = false;
    });
  });

  // ── Flash routing ─────────────────────────────────────────────────────────
  // xr.js calls notifyControllerFire(index) just before shootFromRay.
  // Returns false when the left gun is gated — xr.js skips the shot entirely.
  let _firingController = -1;

  function notifyControllerFire(index) {
    if (index === _leftControllerIndex && !_leftGunActive) return false;
    _firingController = index;
    return true;
  }

  /** Called by shoot.js's onFire callback on every shot. */
  function flashMuzzle() {
    if (_firingController >= 0 && renderer.xr.isPresenting) {
      controllerGuns[_firingController].flashMuzzle();
    } else {
      cameraGun.flashMuzzle();
    }
  }

  /** Called every frame. Fades all active gun flashes. */
  function updateWeapon(delta) {
    cameraGun.updateFlash(delta);
    controllerGuns.forEach((g) => g.updateFlash(delta));
  }

  /**
   * setHidden(bool) — hide/show the camera gun.
   * Called by armode.js to hide the gun on handheld phone AR.
   * Controller guns manage their own visibility via connected/disconnected.
   */
  function setHidden(hidden) {
    cameraGun.group.visible = !hidden;
  }

  return { updateWeapon, flashMuzzle, notifyControllerFire, setLeftGunActive, setHidden };
}

// ── Muzzle-flash burst texture (drawn once, shared across all gun units) ─────
function createMuzzleTexture() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx = S / 2, cy = S / 2;
  ctx.clearRect(0, 0, S, S);

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, S / 2);
  glow.addColorStop(0, 'rgba(255,240,200,0.9)');
  glow.addColorStop(0.3, 'rgba(247,147,26,0.7)');
  glow.addColorStop(0.7, 'rgba(247,147,26,0.18)');
  glow.addColorStop(1, 'rgba(247,147,26,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, S / 2, 0, Math.PI * 2);
  ctx.fill();

  const spikes = 13;
  const outer  = S * 0.48;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (i / (spikes * 2)) * Math.PI * 2;
    const isOuter = i % 2 === 0;
    const r = isOuter
      ? outer * (0.6 + Math.random() * 0.4)
      : S * (0.1 + Math.random() * 0.08);
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  fill.addColorStop(0, 'rgba(255,255,255,1)');
  fill.addColorStop(0.35, 'rgba(255,205,100,0.98)');
  fill.addColorStop(1, 'rgba(247,147,26,0.6)');
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
